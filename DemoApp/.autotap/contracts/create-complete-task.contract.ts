import { defineContract } from "@aarwitz/tapp/contracts";

export default defineContract({
  name: "customerCreatesAndCompletesTask",
  title: "A customer creates a task and completes it",
  businessValue: "Protect the primary state-changing task workflow, including creation, detail mutation, and filtered list visibility.",
  criticality: "high",
  platforms: ["ios"],
  policy: { always: true, prRelevant: true, nightly: true, tags: ["crud", "state", "tasks"] },
  actors: {
    customer: { role: "customer", session: "default" },
  },
  steps: [
    { actor: "customer", task: "completeOnboarding" },
    { actor: "customer", task: "openTodoList" },
    {
      actor: "customer",
      task: "createTodoItem",
      with: { title: "Tapp stateful contract" },
      save: { createdTitle: "CREATED_TASK" },
    },
    { actor: "customer", task: "completeTodoItem", with: { title: "$CREATED_TASK" } },
    { actor: "customer", expect: { exists: "$CREATED_TASK" } },
  ],
  coverage: {
    nodes: [
      "get-started",
      "dashboard",
      "todo-list",
      "new-task",
      "todo-list--task-notes-field",
    ],
    edges: [
      "edge_32dc8ecd97e7d5ec",
      "edge_2b92881330f7a779",
      "edge_149302aba559ba1c",
      "edge_678d2e0ab58d2f73",
      "edge_cd9ba27e60afbe1d",
      "edge_d6cee146b4c0b8fc",
    ],
    capabilities: ["task creation", "task completion", "state propagation", "filtered persistence"],
    sourcePaths: ["Sources/ContentView.swift", "Sources/TodoView.swift"],
  },
});
