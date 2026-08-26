import { Address, BigInt, Bytes, dataSource, ethereum } from '@graphprotocol/graph-ts';
import { Token, Donor, CampaignToken, DonorTokenTotal } from '../generated/schema';
import { ERC20 } from '../generated/DonationVault/ERC20';

/**
 * Native currency sentinel used by every ETH Cali contract. It is not a
 * contract, so symbol()/decimals() must never be called on it.
 */
export const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const ZERO = BigInt.fromI32(0);
export const ONE = BigInt.fromI32(1);

/** Celo's native currency is CELO; every other chain we deploy to uses ETH. */
function nativeSymbol(): string {
  return dataSource.network() == 'celo' ? 'CELO' : 'ETH';
}

export function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + '-' + event.logIndex.toString();
}

/**
 * Load or create a Token, reading metadata from the chain.
 *
 * decimals is read, never assumed: USDC is 6 and COPm is 18, and defaulting to
 * 18 would overstate a USDC amount by 10^12 everywhere it is displayed. A token
 * whose calls revert is stored as UNKNOWN/18 rather than dropped, so the
 * donation itself is still indexed.
 */
export function loadToken(address: Address): Token {
  let id = address.toHexString();
  let token = Token.load(id);
  if (token != null) return token;

  token = new Token(id);
  token.address = address;

  if (id == NATIVE_SENTINEL) {
    let symbol = nativeSymbol();
    token.symbol = symbol;
    token.name = symbol;
    token.decimals = 18;
    token.isNative = true;
    token.save();
    return token;
  }

  let erc20 = ERC20.bind(address);
  let symbolCall = erc20.try_symbol();
  let nameCall = erc20.try_name();
  let decimalsCall = erc20.try_decimals();

  token.symbol = symbolCall.reverted ? 'UNKNOWN' : symbolCall.value;
  token.name = nameCall.reverted ? 'Unknown token' : nameCall.value;
  token.decimals = decimalsCall.reverted ? 18 : decimalsCall.value;
  token.isNative = false;
  token.save();
  return token;
}

export function loadDonor(address: Address, timestamp: BigInt): Donor {
  let id = address.toHexString();
  let donor = Donor.load(id);
  if (donor != null) return donor;

  donor = new Donor(id);
  donor.address = address;
  donor.donationCount = 0;
  donor.firstDonationAt = timestamp;
  donor.lastDonationAt = timestamp;
  donor.save();
  return donor;
}

export function campaignTokenId(campaignId: BigInt, token: Address): string {
  return campaignId.toString() + '-' + token.toHexString();
}

export function loadCampaignToken(campaignId: BigInt, token: Address): CampaignToken {
  let id = campaignTokenId(campaignId, token);
  let ct = CampaignToken.load(id);
  if (ct != null) return ct;

  ct = new CampaignToken(id);
  ct.campaign = campaignId.toString();
  ct.token = loadToken(token).id;
  // A donation can only arrive for an accepted token, so seeing one before the
  // TokenAccepted event means we started indexing mid-campaign, not that the
  // token is unaccepted.
  ct.accepted = true;
  ct.totalRaised = ZERO;
  ct.available = ZERO;
  ct.donationCount = 0;
  ct.save();
  return ct;
}

export function donorTotalId(campaignId: BigInt, token: Address, donor: Address): string {
  return campaignId.toString() + '-' + token.toHexString() + '-' + donor.toHexString();
}

/** Returns null when the total does not exist yet — the caller needs to know,
 *  because a first-time total is what increments a campaign's donor count. */
export function loadDonorTotal(
  campaignId: BigInt,
  token: Address,
  donor: Address
): DonorTokenTotal | null {
  return DonorTokenTotal.load(donorTotalId(campaignId, token, donor));
}

export function bytesToHex(value: Bytes): string {
  return value.toHexString();
}
