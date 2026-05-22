import SwiftUI

/// Adds a tap gesture that dismisses the keyboard. Wraps the dance of
/// resigning first responder via UIKit on iOS while no-op'ing on other
/// platforms so the API stays uniform.
public struct KeyboardDismissModifier: ViewModifier {
  public init() {}

  public func body(content: Content) -> some View {
    #if canImport(UIKit)
    content
      .contentShape(Rectangle())
      .onTapGesture {
        let scenes = UIApplication.shared.connectedScenes
        let windowScene = scenes.first as? UIWindowScene
        windowScene?.keyWindow?.endEditing(true)
      }
    #else
    content
    #endif
  }
}

public extension View {
  /// Tap anywhere in the view to dismiss the keyboard. Idempotent on
  /// non-iOS targets.
  func dismissKeyboardOnTap() -> some View {
    modifier(KeyboardDismissModifier())
  }
}
