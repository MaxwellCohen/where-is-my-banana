/** Agent prompt that captures a Next.js analyze graph and loads it into this visualizer. */
export function buildAgentPrompt(visualizerUrl: string): string {
  const url = visualizerUrl.replace(/\/$/, "");
  return `Cut this site's first-load client JS and fix its top performance issues. Every change must be backed by a measurement. Scope: Next.js 16+ or Vite.

1. From the project root (Node >= 20), run the one-command speed audit. It runs the static audit, the bundle ranking and (with \`--url <site>\`) a live-page audit, then writes a ranked plan to \`.wimb/plan.md\` (add \`.wimb/\` to .gitignore):

\`\`\`bash
npx --yes @maxwellcohen/wimb speed
\`\`\`

2. Work through \`.wimb/plan.md\` top to bottom ("Do first" before "Needs a human decision"). After each fix, rebuild, re-run the command, and keep the edit only if the finding clears or the bytes drop. Read heuristic findings before editing; they can be false positives. For a lazy win, verify the bytes actually dropped and revert if not.

3. Open the visualizer pre-loaded with the results (no file picking). It opens ${url} in the user's browser with the graph and wins embedded in the link:

\`\`\`bash
npx --yes @maxwellcohen/wimb open
\`\`\`

For large graphs this serves the data from localhost until the page loads it (up to 2 minutes), so run it in the background and don't wait on it. If no browser opens, add \`--no-launch\` and give the user the printed URL.

Finish with the before/after first-load size and the edits made.
`;
}
