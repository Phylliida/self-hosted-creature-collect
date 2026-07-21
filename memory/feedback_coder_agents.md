---
name: feedback_coder_agents
description: User prefers the main agent does the coding itself; coder subagents produce poor code
metadata:
  type: feedback
---

The user interrupted a coder subagent mid-implementation (2026-07, todo-extra feature) and said coder agents "aren't very good at coding", recommending the main agent do implementation work directly.

**How to apply:** in this project, don't delegate implementation to `coder` subagents — write the code in the main session. Read-only `explore` agents for codebase investigation are still fine (that part of the workflow wasn't criticized).
