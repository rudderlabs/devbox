"""DeepAgents v1 execution-event contract shared by producer and evaluator.

Kept dependency-free so the offline evaluator can import it without loading
DeepAgents, LangChain, or LangGraph.
"""

from __future__ import annotations

VERSION = 1
STREAM_VERSION = "v3"
TERMINAL_EVENTS = frozenset({
    "invocation_finished",
    "invocation_interrupted",
    "invocation_failed",
})
EVENTS = TERMINAL_EVENTS | {
    "invocation_started",
    "model_started",
    "model_finished",
    "tool_started",
    "tool_finished",
    "tool_failed",
    "subgraph_lifecycle",
}
SUBGRAPH_STATUSES = frozenset({"started", "completed", "failed", "interrupted"})
PACKAGES = (
    "devbox-harness",
    "deepagents",
    "langchain",
    "langchain-core",
    "langchain-openai",
    "langgraph",
    "langchain-protocol",
)
