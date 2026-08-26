# ETH Cali Smart Contracts — Conventions

**Two toolchains, on purpose.** Hardhat 3 + viem + `node:test` for integration tests,
deployment and verification. Foundry for fuzz and invariant testing of the money-critical
contracts. Solidity 0.8.28, OpenZeppelin 5.4, optimizer runs 1, viaIR, cancun.

`foundry.toml` mirrors `hardhat.config.ts` exactly so both compile identical bytecode.
**Change one, change the other.**

See `../CLAUDE.md` for workspace-wide rules (architecture, verified addresses, skills to load).

## Load These Skills First

Installed in-repo and pinned in `skills-lock.json` (`npx skills update` to refresh):

| Doing this | Load |
|-----------|------|
| Anything touching `hardhat.config.ts`, the `hardhat` import, `network.connect()`, or a test | `hardhat` |
| viem clients, `deployContract`, `read`/`write`, `viem.assertions` | `hardhat-toolbox-viem` |

**Where they disagree with this file, this file wins.** The upstream `hardhat` skill
recommends Solidity `.t.sol` tests as the default unit-test layer. This repo deliberately
splits differently — TypeScript for flows and integration, Foundry for fuzz and invariants
on contracts that hold funds — because the Foundry side predates Hardhat 3's Solidity test
runner and the invariant handlers depend on it. Do not restructure the suite to match the
skill.

See `../CLAUDE.md` for the workspace-wide `ethskills` table (security, indexing, frontend).

## Verification (MANDATORY)

```bash
npm run test:all              # both toolchains — the real gate
npx hardhat test              # Hardhat suite only
npx hardhat test test/X.test.ts
npm run test:forge            # Foundry invariants only
npm run test:forge:deep       # 10k fuzz runs / 1k invariant runs — before a mainnet deploy
```

Nothing is done until it passes. Report real counts.

## Which toolchain for what

| Write this in | When |
|---------------|------|
| `test/*.test.ts` (Hardhat) | A specific flow, a revert, a role check, an event, a multi-contract integration |
| `test/forge/*.t.sol` (Foundry) | A property that must hold under **any** sequence of calls — accounting integrity, campaign isolation, "can never withdraw more than raised" |

Example-based tests prove the paths you thought of. Invariants catch the sequences you did
not. Both are required for anything holding funds.

`test/forge/DonationVault.invariants.t.sol` is the reference pattern: a handler contract
that the fuzzer drives, plus `invariant_*` assertions. Note `fail_on_revert = false` in
`foundry.toml` — handlers return early on impossible states rather than reverting, and the
call summary printed with `-vv` is how you confirm the fuzzer actually reached each branch
rather than bouncing off a guard.

Foundry's `block-timestamp` lint warnings on the staking deadlines are expected and
acceptable: a validator shifting a timestamp by seconds cannot meaningfully game a
multi-day hackathon registration window.

## Contract Conventions

Every contract follows the same shape — match it rather than inventing a new one:

- `AccessControl + ReentrancyGuard + Pausable`, with `ADMIN_ROLE` for operations and
  `DEFAULT_ADMIN_ROLE` for anything that moves custody or changes where funds go.
- Native ETH uses the sentinel `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.
- Revert strings are prefixed `ContractName: `; newer contracts use custom errors.
- **Every gated write has a matching `canUserX()` view** returning `(bool, string reason)`
  that mirrors *every* `require`, so the UI disables a button with a reason instead of
  surfacing a failed transaction. Keep them in sync when you change a check.
- **Anything that loops over users is paginated** with a stored cursor. A campaign or
  hackathon with thousands of participants must never brick on gas.
- `getAll…()` / `getActive…()` pairs for list views.

## Testing Conventions

- `node:test` + `assert/strict` + viem. Reverts are asserted with `try { … assert.fail() }
  catch (e) { assert(e.message.includes("…")) }`, or `assert.rejects(fn, /CustomError/)`.
- **Use `test/helpers/zkpassport.ts`** to deploy ZKPassportNFT and mint passports. It wires
  the mock verifier. Four suites once broke simultaneously because this plumbing was
  copy-pasted into each of them.
- Suites share state across `it` blocks via a single `before`. Create a fresh
  campaign/hackathon per test rather than depending on ordering.
- Time-travel (`testClient.increaseTime`) moves the clock for every later test — keep those
  tests last.
- Prefer asserting on **contract balance deltas** over EOA balances; EOA deltas are noisy
  with gas.
- Close each suite with an accounting invariant test (contract balance == sum of tracked
  principal/available). It catches drift nothing else does.

## Gotchas That Have Bitten Before

- **`Swag1155` is clone-only.** Its constructor sets `_initialized = true`, so a directly
  deployed instance can never be configured. Tests must get instances from
  `SwagFactory.deployCollection()`.
- **`Swag1155` prices are per payment token** (`setPaymentOption`), not a field on the
  variant. `buy()` takes a `paymentToken` argument.
- **`ZKPassportNFT`'s constructor takes 5 args** (name, symbol, owner, domain, scope) and
  minting is proof-based `mint(params, isIDCard)` against a verifier.
- **Hardhat cannot decode a revert reason for a bare ETH transfer** into `receive()`.
  Assert the rejection and the unchanged balance instead of the message.
- **Fee-on-transfer tokens**: staking rejects them (a bond must be exact); donations credit
  the measured balance delta (a donation should never be refused).

## Deployment

```bash
npm run deploy:base | :ethereum | :optimism | :unichain | :celo
npm run setup:frontend      # regenerates frontend/abis + per-network addresses.json
npm run verify:<network>
```

`scripts/deploy-all.ts` reads admins/treasury from `.env`. It prints a manual follow-up
step when the deployer is not the configured admin — read the output, do not assume the
role grants happened.

After deploying, copy the new ABIs into `../wallet_ethcali/frontend/abis/`.
