import SwiftUI

struct CounterView: View {
    @State private var count = 0
    @State private var step = 1
    @State private var showingResetDialog = false
    @State private var celebrateChanges = true

    var body: some View {
        Form {
            Section("Counter") {
                Text("\(count)")
                    .font(.system(size: 64, weight: .bold, design: .rounded))
                    .frame(maxWidth: .infinity, alignment: .center)
                    .accessibilityIdentifier("counter_value")

                Stepper("Step Size: \(step)", value: $step, in: 1...5)

                Toggle("Celebrate Changes", isOn: $celebrateChanges)

                HStack(spacing: 12) {
                    Button("Decrement") {
                        count = max(0, count - step)
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)

                    Button("Increment") {
                        count += step
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
            }

            Section("Actions") {
                Button("Reset Counter") {
                    showingResetDialog = true
                }
                .foregroundStyle(.red)

                NavigationLink("Read Release Notes") {
                    AboutView()
                }
            }
        }
        .confirmationDialog("Reset the current value?", isPresented: $showingResetDialog) {
            Button("Reset", role: .destructive) {
                count = 0
            }
            Button("Cancel", role: .cancel) {}
        }
        .navigationTitle("Counter")
    }
}
