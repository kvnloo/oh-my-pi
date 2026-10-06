export interface RepositoryNode {
  id: string; label: string; code: number; churn: number; children: RepositoryNode[];
}
export interface NativeDocument { version: 1; title: string; root: RepositoryNode }
export interface PreparedArtifact {
  schema: 'omp-native-visual/v1'; id: string; rendererHash: string; document: NativeDocument;
}
export interface HumanReceipt { method: 'human-inspected'; id: string; rendererHash: string; scope: string }
export const MAX_BYTES: number;
export const MAX_NODES: number;
export const MAX_DEPTH: number;
export const VISIBLE_LIMIT: number;
export function digest(value: string): string;
export function normalize(json: string): NativeDocument;
export function prepare(json: string, rendererHash: string): PreparedArtifact;
export function assertReviewed(artifact: PreparedArtifact, receipt: HumanReceipt | undefined, scope: string, rendererHash: string): void;
export function visibleChildren(node: RepositoryNode, mode?: 'code' | 'churn', limit?: number): RepositoryNode[];
