import { BigInt, dataSource } from '@graphprotocol/graph-ts';
import {
  CampaignCreated,
  CampaignUpdated,
  BeneficiaryUpdated,
  AutoForwardUpdated,
  ReceiptCollectionUpdated,
  TokenAccepted,
  Donated,
  Forwarded,
  ForwardFailed,
  Withdrawn,
  ReceiptIssued,
  ReceiptFailed,
} from '../generated/DonationVault/DonationVault';
import {
  Campaign,
  Donation,
  DonorTokenTotal,
  Payout,
  ForwardFailure,
  TxDonation,
} from '../generated/schema';
import {
  ONE,
  ZERO,
  eventId,
  loadCampaignToken,
  loadDonor,
  loadDonorTotal,
  loadToken,
  donorTotalId,
} from './helpers';

function txDonationId(txHash: string, campaignId: BigInt): string {
  return txHash + '-' + campaignId.toString();
}

// ── Campaign lifecycle ──────────────────────────────────────────────────────

export function handleCampaignCreated(event: CampaignCreated): void {
  let campaign = new Campaign(event.params.campaignId.toString());
  campaign.campaignId = event.params.campaignId;
  campaign.network = dataSource.network();
  campaign.vault = event.address;
  campaign.name = event.params.name;
  // CampaignCreated does not carry the description; CampaignUpdated fills it.
  campaign.description = '';
  campaign.beneficiary = event.params.beneficiary;
  campaign.receiptCollection = event.params.receiptCollection;
  campaign.autoForward = event.params.autoForward;
  campaign.active = true;
  campaign.createdAt = event.block.timestamp;
  campaign.createdAtBlock = event.block.number;
  campaign.donorCount = 0;
  campaign.donationCount = 0;
  campaign.save();
}

export function handleCampaignUpdated(event: CampaignUpdated): void {
  let campaign = Campaign.load(event.params.campaignId.toString());
  if (campaign == null) return;
  campaign.name = event.params.name;
  campaign.description = event.params.description;
  campaign.active = event.params.active;
  campaign.save();
}

export function handleBeneficiaryUpdated(event: BeneficiaryUpdated): void {
  let campaign = Campaign.load(event.params.campaignId.toString());
  if (campaign == null) return;
  campaign.beneficiary = event.params.newBeneficiary;
  campaign.save();
}

export function handleAutoForwardUpdated(event: AutoForwardUpdated): void {
  let campaign = Campaign.load(event.params.campaignId.toString());
  if (campaign == null) return;
  campaign.autoForward = event.params.autoForward;
  campaign.save();
}

export function handleReceiptCollectionUpdated(event: ReceiptCollectionUpdated): void {
  let campaign = Campaign.load(event.params.campaignId.toString());
  if (campaign == null) return;
  campaign.receiptCollection = event.params.newCollection;
  campaign.save();
}

export function handleTokenAccepted(event: TokenAccepted): void {
  let ct = loadCampaignToken(event.params.campaignId, event.params.token);
  ct.accepted = event.params.accepted;
  ct.save();
}

// ── Donations ───────────────────────────────────────────────────────────────

export function handleDonated(event: Donated): void {
  let campaignId = event.params.campaignId;
  let token = loadToken(event.params.token);
  let donor = loadDonor(event.params.donor, event.block.timestamp);

  let donation = new Donation(eventId(event));
  donation.network = dataSource.network();
  donation.campaign = campaignId.toString();
  donation.donor = donor.id;
  donation.token = token.id;
  donation.amount = event.params.amount;
  donation.message = event.params.message;
  donation.timestamp = event.block.timestamp;
  donation.blockNumber = event.block.number;
  donation.txHash = event.transaction.hash;
  donation.logIndex = event.logIndex;
  // Resolved by events later in this same transaction.
  donation.forwarded = false;
  donation.receiptFailed = false;
  donation.save();

  // Leave a pointer so Forwarded / ReceiptIssued can find this donation.
  let pointer = new TxDonation(
    txDonationId(event.transaction.hash.toHexString(), campaignId)
  );
  pointer.donation = donation.id;
  pointer.save();

  // ── Aggregates ───────────────────────────────────────────────────────────
  let ct = loadCampaignToken(campaignId, event.params.token);
  ct.totalRaised = ct.totalRaised.plus(event.params.amount);
  ct.available = ct.available.plus(event.params.amount);
  ct.donationCount = ct.donationCount + 1;
  ct.save();

  // A donor is "new to this campaign+token" only if no total exists yet. This
  // is what keeps donorCount a count of people rather than of donations.
  let existing = loadDonorTotal(campaignId, event.params.token, event.params.donor);
  let total: DonorTokenTotal;
  let isFirstForCampaign = false;

  if (existing == null) {
    total = new DonorTokenTotal(
      donorTotalId(campaignId, event.params.token, event.params.donor)
    );
    total.campaign = campaignId.toString();
    total.token = token.id;
    total.donor = donor.id;
    total.amount = ZERO;
    total.donationCount = 0;
    total.lastDonationAt = event.block.timestamp;
    isFirstForCampaign = true;
  } else {
    total = existing;
  }

  total.amount = total.amount.plus(event.params.amount);
  total.donationCount = total.donationCount + 1;
  total.lastDonationAt = event.block.timestamp;
  if (event.params.message != '') total.lastMessage = event.params.message;
  total.save();

  donor.donationCount = donor.donationCount + 1;
  donor.lastDonationAt = event.block.timestamp;
  donor.save();

  let campaign = Campaign.load(campaignId.toString());
  if (campaign != null) {
    campaign.donationCount = campaign.donationCount + 1;
    if (isFirstForCampaign) campaign.donorCount = campaign.donorCount + 1;
    campaign.save();
  }
}

export function handleForwarded(event: Forwarded): void {
  // The vault never holds what it forwards, so available drops back.
  let ct = loadCampaignToken(event.params.campaignId, event.params.token);
  ct.available = ct.available.minus(event.params.amount);
  ct.save();

  let payout = new Payout(eventId(event));
  payout.campaign = event.params.campaignId.toString();
  payout.token = loadToken(event.params.token).id;
  payout.beneficiary = event.params.beneficiary;
  payout.amount = event.params.amount;
  payout.kind = 'AUTO_FORWARD';
  payout.timestamp = event.block.timestamp;
  payout.blockNumber = event.block.number;
  payout.txHash = event.transaction.hash;
  payout.save();

  let pointer = TxDonation.load(
    txDonationId(event.transaction.hash.toHexString(), event.params.campaignId)
  );
  if (pointer == null) return;
  let donation = Donation.load(pointer.donation);
  if (donation == null) return;
  donation.forwarded = true;
  donation.save();
}

export function handleForwardFailed(event: ForwardFailed): void {
  let failure = new ForwardFailure(eventId(event));
  failure.campaign = event.params.campaignId.toString();
  failure.token = loadToken(event.params.token).id;
  failure.amount = event.params.amount;
  failure.timestamp = event.block.timestamp;
  failure.blockNumber = event.block.number;
  failure.txHash = event.transaction.hash;
  failure.save();
}

export function handleWithdrawn(event: Withdrawn): void {
  let ct = loadCampaignToken(event.params.campaignId, event.params.token);
  ct.available = ct.available.minus(event.params.amount);
  ct.save();

  let payout = new Payout(eventId(event));
  payout.campaign = event.params.campaignId.toString();
  payout.token = loadToken(event.params.token).id;
  payout.beneficiary = event.params.beneficiary;
  payout.amount = event.params.amount;
  payout.kind = 'WITHDRAWAL';
  payout.timestamp = event.block.timestamp;
  payout.blockNumber = event.block.number;
  payout.txHash = event.transaction.hash;
  payout.save();
}

// ── Receipts, as seen from the vault ────────────────────────────────────────

export function handleReceiptIssued(event: ReceiptIssued): void {
  let pointer = TxDonation.load(
    txDonationId(event.transaction.hash.toHexString(), event.params.campaignId)
  );
  if (pointer == null) return;
  let donation = Donation.load(pointer.donation);
  if (donation == null) return;
  donation.receiptTokenId = event.params.receiptTokenId;
  donation.save();
}

/**
 * The donation succeeded but the receipt mint reverted.
 *
 * Recorded on the donation rather than dropped: this is the state every chain
 * was in before the tiers were configured, and it is invisible on-chain unless
 * someone reads the event.
 */
export function handleReceiptFailed(event: ReceiptFailed): void {
  let pointer = TxDonation.load(
    txDonationId(event.transaction.hash.toHexString(), event.params.campaignId)
  );
  if (pointer == null) return;
  let donation = Donation.load(pointer.donation);
  if (donation == null) return;
  donation.receiptFailed = true;
  donation.receiptTokenId = event.params.receiptTokenId;
  donation.save();
}
