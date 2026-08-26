import { dataSource } from '@graphprotocol/graph-ts';
import {
  TierSet,
  TierRemoved,
  ReceiptMinted,
} from '../generated/DonationReceipt1155/DonationReceipt1155';
import { ReceiptTier, Receipt } from '../generated/schema';
import { ZERO, eventId } from './helpers';

export function handleTierSet(event: TierSet): void {
  let id = event.params.tokenId.toString();
  let tier = ReceiptTier.load(id);
  if (tier == null) {
    tier = new ReceiptTier(id);
    tier.tokenId = event.params.tokenId;
    tier.minted = ZERO;
  }
  tier.name = event.params.name;
  tier.metadataURI = event.params.metadataURI;
  tier.active = event.params.active;
  tier.save();
}

/**
 * A removed tier is deactivated, not deleted.
 *
 * Receipts already minted at that tier still exist in donors' wallets and still
 * point here for their metadata. Deleting the entity would leave those Receipt
 * rows dangling.
 */
export function handleTierRemoved(event: TierRemoved): void {
  let tier = ReceiptTier.load(event.params.tokenId.toString());
  if (tier == null) return;
  tier.active = false;
  tier.save();
}

export function handleReceiptMinted(event: ReceiptMinted): void {
  let tierId = event.params.tokenId.toString();

  // A mint can only reference a configured tier, but index from any block and
  // the TierSet may be behind us. Create a placeholder rather than drop the
  // receipt; a later TierSet fills in the name and URI.
  let tier = ReceiptTier.load(tierId);
  if (tier == null) {
    tier = new ReceiptTier(tierId);
    tier.tokenId = event.params.tokenId;
    tier.name = '';
    tier.metadataURI = '';
    tier.active = true;
    tier.minted = ZERO;
  }
  tier.minted = tier.minted.plus(event.params.amount);
  tier.save();

  let receipt = new Receipt(eventId(event));
  receipt.network = dataSource.network();
  receipt.to = event.params.to;
  receipt.tier = tier.id;
  receipt.amount = event.params.amount;
  receipt.timestamp = event.block.timestamp;
  receipt.blockNumber = event.block.number;
  receipt.txHash = event.transaction.hash;
  receipt.save();
}
