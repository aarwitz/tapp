import SwiftUI

enum TaskCategory: String, CaseIterable, Identifiable {
    case qa = "QA"
    case product = "Product"
    case infrastructure = "Infra"

    var id: String { rawValue }
}

enum TaskFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case open = "Open"
    case done = "Done"

    var id: String { rawValue }
}

struct TodoItem: Identifiable, Hashable {
    let id = UUID()
    var title: String
    var category: TaskCategory
    var done: Bool = false
    var notes: String = ""
}

struct TodoView: View {
    @State private var items: [TodoItem] = [
        TodoItem(title: "Verify onboarding modal", category: .qa, notes: "Confirm dismiss buttons are tappable."),
        TodoItem(title: "Review coverage narrative", category: .product),
        TodoItem(title: "Stabilize simulator retry path", category: .infrastructure),
    ]
    @State private var newTitle = ""
    @State private var newCategory: TaskCategory = .qa
    @State private var searchText = ""
    @State private var filter: TaskFilter = .all
    @State private var showingComposer = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Filter", selection: $filter) {
                        ForEach(TaskFilter.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Pinned") {
                    Button("Create New Task") {
                        showingComposer = true
                    }

                    NavigationLink("Open Counter Playground") {
                        CounterView()
                    }
                }

                Section("Tasks") {
                    ForEach(filteredItems) { item in
                        NavigationLink {
                            TaskDetailView(task: binding(for: item.id)) {
                                deleteTask(id: item.id)
                            }
                        } label: {
                            taskRow(item)
                        }
                    }
                }
            }
            .searchable(text: $searchText)
            .navigationTitle("Todo List")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add") {
                        showingComposer = true
                    }
                }
            }
            .sheet(isPresented: $showingComposer) {
                NavigationStack {
                    Form {
                        TextField("New task", text: $newTitle)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("new_task_field")

                        Picker("Category", selection: $newCategory) {
                            ForEach(TaskCategory.allCases) { category in
                                Text(category.rawValue).tag(category)
                            }
                        }
                    }
                    .navigationTitle("New Task")
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Cancel") {
                                resetComposer()
                                showingComposer = false
                            }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Save") {
                                let trimmedTitle = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !trimmedTitle.isEmpty else { return }
                                items.insert(TodoItem(title: trimmedTitle, category: newCategory, notes: "Created from the composer sheet."), at: 0)
                                resetComposer()
                                showingComposer = false
                            }
                            .disabled(newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                }
            }
        }
    }

    private var filteredItems: [TodoItem] {
        items.filter { item in
            let matchesSearch = searchText.isEmpty
                || item.title.localizedCaseInsensitiveContains(searchText)
                || item.notes.localizedCaseInsensitiveContains(searchText)
            let matchesFilter: Bool
            switch filter {
            case .all:
                matchesFilter = true
            case .open:
                matchesFilter = !item.done
            case .done:
                matchesFilter = item.done
            }
            return matchesSearch && matchesFilter
        }
    }

    /// ID-keyed binding (not index-based). Deleting a task while its detail view is still on
    /// screen used to leave a stale `$items[index]` binding that crashed on next access; keying
    /// by id makes get/set safe no-ops once the task is gone.
    private func binding(for id: UUID) -> Binding<TodoItem> {
        Binding(
            get: { items.first(where: { $0.id == id }) ?? TodoItem(title: "", category: .qa) },
            set: { newValue in
                if let index = items.firstIndex(where: { $0.id == id }) {
                    items[index] = newValue
                }
            }
        )
    }

    private func taskRow(_ item: TodoItem) -> some View {
        HStack(alignment: .top) {
            Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(item.done ? .green : .secondary)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .strikethrough(item.done)
                Text(item.category.rawValue)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if item.done {
                Text("Done")
                    .font(.caption)
                    .foregroundStyle(.green)
            }
        }
    }

    private func deleteTask(id: UUID) {
        items.removeAll { $0.id == id }
    }

    private func resetComposer() {
        newTitle = ""
        newCategory = .qa
    }
}

private struct TaskDetailView: View {
    @Binding var task: TodoItem
    let onDelete: () -> Void
    @State private var showingDeleteDialog = false

    var body: some View {
        Form {
            Section("Status") {
                Toggle("Completed", isOn: $task.done)
                Picker("Category", selection: $task.category) {
                    ForEach(TaskCategory.allCases) { category in
                        Text(category.rawValue).tag(category)
                    }
                }
            }

            Section("Notes") {
                TextField("Task notes", text: $task.notes, axis: .vertical)
                    .lineLimit(3, reservesSpace: true)
                    .accessibilityIdentifier("task_notes_field")
            }

            Section("Actions") {
                Button(task.done ? "Reopen Task" : "Mark Complete") {
                    task.done.toggle()
                }

                Button("Delete Task", role: .destructive) {
                    showingDeleteDialog = true
                }
            }
        }
        .confirmationDialog("Delete this task?", isPresented: $showingDeleteDialog) {
            Button("Delete", role: .destructive) {
                onDelete()
            }
            Button("Cancel", role: .cancel) {}
        }
        .navigationTitle("Todo List")
    }
}
