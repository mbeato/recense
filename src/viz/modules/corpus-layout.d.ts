export declare function layoutCorpus(
  nodes: { id: string }[],
  links: ({ source: string | { id: string }; target: string | { id: string } })[],
  opts?: Partial<{
    ticks: number;
    charge: number;
    linkDist: number;
    linkStrength: number;
    center: number;
    collide: number;
    ringRadius: number;
  }>
): Map<string, { x: number; z: number }>;
