import XCTest
@testable import DankDashDomain

/// Wire-format guards. The raw values on these enums are the contract
/// with the backend — a quiet rename would silently break decoding, so
/// every case is asserted explicitly here.
final class CatalogEnumsTests: XCTestCase {
  func test_productTypeRawValuesMatchWire() {
    XCTAssertEqual(ProductType.flower.rawValue, "flower")
    XCTAssertEqual(ProductType.preroll.rawValue, "preroll")
    XCTAssertEqual(ProductType.infusedPreroll.rawValue, "infused_preroll")
    XCTAssertEqual(ProductType.vape.rawValue, "vape")
    XCTAssertEqual(ProductType.edible.rawValue, "edible")
    XCTAssertEqual(ProductType.beverage.rawValue, "beverage")
    XCTAssertEqual(ProductType.concentrate.rawValue, "concentrate")
    XCTAssertEqual(ProductType.tincture.rawValue, "tincture")
    XCTAssertEqual(ProductType.topical.rawValue, "topical")
    XCTAssertEqual(ProductType.accessory.rawValue, "accessory")
    XCTAssertEqual(ProductType.seed.rawValue, "seed")
    XCTAssertEqual(ProductType.clone.rawValue, "clone")
    XCTAssertEqual(ProductType.allCases.count, 12)
  }

  func test_strainTypeRawValuesMatchWire() {
    XCTAssertEqual(StrainType.indica.rawValue, "indica")
    XCTAssertEqual(StrainType.sativa.rawValue, "sativa")
    XCTAssertEqual(StrainType.hybrid.rawValue, "hybrid")
    XCTAssertEqual(StrainType.cbd.rawValue, "cbd")
    XCTAssertEqual(StrainType.balanced.rawValue, "balanced")
    XCTAssertEqual(StrainType.allCases.count, 5)
  }

  func test_licenseTypeRawValuesMatchWire() {
    XCTAssertEqual(LicenseType.retailer.rawValue, "retailer")
    XCTAssertEqual(LicenseType.microbusiness.rawValue, "microbusiness")
    XCTAssertEqual(LicenseType.mezzobusiness.rawValue, "mezzobusiness")
    XCTAssertEqual(LicenseType.medicalCombo.rawValue, "medical_combo")
    XCTAssertEqual(LicenseType.deliveryService.rawValue, "delivery_service")
    XCTAssertEqual(LicenseType.lpheRetailer.rawValue, "lphe_retailer")
    XCTAssertEqual(LicenseType.allCases.count, 6)
  }

  func test_dispensaryStatusRawValuesMatchWire() {
    XCTAssertEqual(Dispensary.Status.onboarding.rawValue, "onboarding")
    XCTAssertEqual(Dispensary.Status.active.rawValue, "active")
    XCTAssertEqual(Dispensary.Status.paused.rawValue, "paused")
    XCTAssertEqual(Dispensary.Status.terminated.rawValue, "terminated")
    XCTAssertEqual(Dispensary.Status.allCases.count, 4)
  }
}
