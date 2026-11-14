/** Test-only indexing process that allocates until it exceeds its heap budget. */
const hoard: string[][] = [];
for (;;) hoard.push(Array.from({ length: 100_000 }, (_, i) => `entry-${i}-${hoard.length}`));
