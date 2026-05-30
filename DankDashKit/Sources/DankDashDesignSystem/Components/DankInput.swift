import SwiftUI

public struct DankInput: View {
  public enum ValidationState: Sendable, Equatable {
    case idle
    case valid
    case invalid(String)
  }

  public enum Kind: Sendable {
    case text
    case secure
    case email
    case phone
  }

  private let label: String
  private let placeholder: String?
  @Binding private var text: String
  private let kind: Kind
  private let validation: ValidationState
  private let helper: String?

  public init(
    label: String,
    placeholder: String? = nil,
    text: Binding<String>,
    kind: Kind = .text,
    validation: ValidationState = .idle,
    helper: String? = nil
  ) {
    self.label = label
    self.placeholder = placeholder
    self._text = text
    self.kind = kind
    self.validation = validation
    self.helper = helper
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xxs) {
      Text(label)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.secondary)

      Group {
        switch kind {
        case .text, .email, .phone:
          inputField
        case .secure:
          SecureField(placeholder ?? "", text: $text)
        }
      }
      .font(DankFont.body)
      .foregroundStyle(DankColor.Text.primary)
      .padding(.horizontal, DankSpacing.md)
      .padding(.vertical, DankSpacing.sm)
      .frame(minHeight: 48)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
          .strokeBorder(borderColor, lineWidth: borderWidth)
      )

      if let helperText {
        Text(helperText)
          .font(DankFont.caption)
          .foregroundStyle(helperColor)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(label)
    .accessibilityValue(text)
  }

  private var helperText: String? {
    switch validation {
    case .invalid(let message): message
    case .idle, .valid: helper
    }
  }

  private var helperColor: Color {
    switch validation {
    case .invalid: DankColor.Semantic.danger
    case .valid: DankColor.Semantic.success
    case .idle: DankColor.Text.muted
    }
  }

  private var borderColor: Color {
    switch validation {
    case .invalid: DankColor.Semantic.danger
    case .valid: DankColor.Semantic.success
    case .idle: DankColor.primary.opacity(0.18)
    }
  }

  private var borderWidth: CGFloat {
    switch validation {
    case .invalid, .valid: 1.5
    case .idle: 1
    }
  }

  @ViewBuilder private var inputField: some View {
    #if canImport(UIKit)
    TextField(placeholder ?? "", text: $text)
      .textInputAutocapitalization(autocapitalization)
      .keyboardType(keyboardType)
      .autocorrectionDisabled(true)
    #else
    TextField(placeholder ?? "", text: $text)
    #endif
  }

  #if canImport(UIKit)
  private var autocapitalization: TextInputAutocapitalization {
    switch kind {
    case .email, .phone, .secure: .never
    case .text: .sentences
    }
  }

  private var keyboardType: UIKeyboardType {
    switch kind {
    case .email: .emailAddress
    case .phone: .phonePad
    case .text, .secure: .default
    }
  }
  #endif
}

private struct DankInputPreview: View {
  @State private var email = ""
  @State private var password = ""

  var body: some View {
    VStack(spacing: DankSpacing.md) {
      DankInput(label: "Email", placeholder: "you@dankdash.test", text: $email, kind: .email)
      DankInput(
        label: "Password",
        text: $password,
        kind: .secure,
        validation: .invalid("Required")
      )
    }
    .padding()
    .background(DankColor.cream)
  }
}

#Preview {
  DankInputPreview()
}
