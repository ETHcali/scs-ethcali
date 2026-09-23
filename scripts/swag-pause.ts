import { network } from "hardhat";

/**
 * Pause or unpause a Swag1155 collection. ADMIN_ROLE on that collection.
 *
 *   COLLECTION=0x… ACTION=pause   npx hardhat run scripts/swag-pause.ts --network base
 *   COLLECTION=0x… ACTION=unpause npx hardhat run scripts/swag-pause.ts --network base
 *
 * Paused, buy() and claim() revert with EnforcedPause; reads still work, so a
 * superseded collection stays inspectable but can never sell again.
 */
async function main() {
  const collection = process.env.COLLECTION as `0x${string}` | undefined;
  const action = process.env.ACTION;
  if (!collection || !/^0x[0-9a-fA-F]{40}$/.test(collection)) throw new Error("COLLECTION must be an address");
  if (action !== "pause" && action !== "unpause") throw new Error("ACTION must be pause or unpause");

  const connection = await network.connect();
  const viem = connection.viem;
  const publicClient = await viem.getPublicClient();
  const swag = await viem.getContractAt("Swag1155", collection);

  const before = (await swag.read.paused()) as boolean;
  console.log(`${collection} paused=${before}`);
  if ((action === "pause") === before) {
    console.log("already in the requested state");
    return;
  }
  const hash = action === "pause" ? await swag.write.pause() : await swag.write.unpause();
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${action} reverted (${hash})`);
  for (let i = 0; i < 20; i++) {
    if (((await swag.read.paused()) as boolean) === (action === "pause")) break;
    if (i === 19) throw new Error("read-back still differs after 30s");
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`✅ ${action}d (${hash})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
