import { encodeAbiParameters, keccak256, concat, type Address, type Hex } from "viem";

/**
 * Ticket-list Merkle tree, matching TianxuanRaffle.settle and the contract tests:
 * leaf = keccak256(keccak256(abi.encode(account, start, count))), sorted-pair hashing, and a node
 * without a sibling is carried up unchanged.
 */
export function leafHash(account: Address, start: bigint, count: bigint): Hex {
  return keccak256(
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [account, start, count])),
  );
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** every level, leaves first; empty for no leaves */
export function buildTree(leaves: Hex[]): Hex[][] {
  if (leaves.length === 0) return [];
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return levels;
}

export const rootOf = (levels: Hex[][]): Hex | null => (levels.length ? levels[levels.length - 1][0] : null);

export function proofFor(levels: Hex[][], index: number): Hex[] {
  const proof: Hex[] = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const sib = index ^ 1;
    if (sib < levels[l].length) proof.push(levels[l][sib]);
    index >>= 1;
  }
  return proof;
}

/** the same check the contract runs, for self-tests */
export function verify(proof: Hex[], root: Hex, leaf: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h === root;
}
