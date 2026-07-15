// Minimal local contract fixture for the sibling opencode-compaction plugin.
// The integration test owns ordering and single-inclusion behavior; the
// compaction plugin's implementation is tested in its own repository.
export const OPERATIONAL_CHECKPOINT_PROMPT = "You are performing OPERATIONAL CHECKPOINT COMPACTION for a future LLM continuation."

export const CompactionPlugin = async () => ({
  "experimental.session.compacting": async (_input, output) => {
    output.prompt = [output.context.filter((entry) => typeof entry === "string" && entry.length > 0).join("\n\n"), OPERATIONAL_CHECKPOINT_PROMPT].filter(Boolean).join("\n\n")
  },
})
