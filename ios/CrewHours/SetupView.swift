import SwiftUI

/// First launch: which company's crew app to open. The boss shares the crew link (or the code at the end of it).
struct SetupView: View {
    @EnvironmentObject var state: AppState
    @State private var text = ""
    @State private var error = ""
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image("Logo")
                    .resizable()
                    .frame(width: 84, height: 84)
                    .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                    .padding(.top, 40)
                Text("Crew Hours")
                    .font(.system(size: 34, weight: .bold))
                Text("Enter the crew link your boss gave you. It looks like mycrewhours.com/c/your-company.")
                    .foregroundStyle(.secondary)
                TextField("mycrewhours.com/c/your-company", text: $text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit(open)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.4)))
                if !error.isEmpty {
                    Text(error).foregroundStyle(.red).font(.callout)
                }
                Button(action: open) {
                    Text("Open")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color("AccentColor"))
                .foregroundStyle(Color.black)
                Text("You only do this once. After that the app opens straight to your PIN.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(24)
        }
        .onAppear { focused = true }
    }

    private func open() {
        guard let url = Config.normalize(text) else {
            error = "That isn't a crew link. It should look like mycrewhours.com/c/your-company."
            return
        }
        error = ""
        state.save(url)
    }
}
