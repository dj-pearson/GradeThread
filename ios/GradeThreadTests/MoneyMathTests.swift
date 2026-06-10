import XCTest
@testable import GradeThread

/// US-790: exact money aggregation. Proves `Money` recovers the intended cents
/// from a binary-float Double and sums without the drift a naive `reduce(0,+)`
/// accumulates over large sets.
final class MoneyMathTests: XCTestCase {

    func test_decimal_recoversExactCents() {
        XCTAssertEqual(Money.decimal(24.99), Decimal(string: "24.99"))
        XCTAssertEqual(Money.decimal(0.1), Decimal(string: "0.10"))
        XCTAssertEqual(Money.decimal(0.2), Decimal(string: "0.20"))
        XCTAssertEqual(Money.decimal(0), Decimal.zero)
        XCTAssertEqual(Money.decimal(1099.95), Decimal(string: "1099.95"))
    }

    func test_classicFloatFamily_isExact() {
        // 0.1 + 0.2 == 0.3 exactly in Decimal (it does NOT in Double). The
        // Decimal == is the exactness proof; the Double check uses a sub-cent
        // tolerance to avoid a 1-ULP NSDecimalNumber.doubleValue flake.
        XCTAssertEqual(Money.sumDecimal([0.1, 0.2]), Decimal(string: "0.30"))
        XCTAssertEqual(Money.sum([0.1, 0.2]), 0.30, accuracy: 0.0001)
    }

    func test_sumOfManyCents_doesNotDrift() {
        // A hundred pennies must total exactly $1.00. Naive Double summation
        // produces 1.0000000000000007 — this asserts we don't.
        let pennies = Array(repeating: 0.01, count: 100)
        XCTAssertEqual(Money.sumDecimal(pennies), Decimal(string: "1.00"))
        XCTAssertEqual(Money.sum(pennies), 1.00, accuracy: 0.0001)
        // Sanity: confirm the naive path actually drifts, so this test is real.
        let naive = pennies.reduce(0.0, +)
        XCTAssertNotEqual(naive, 1.0, "expected the naive Double sum to drift")
    }

    func test_sum_overProjectedField_matchesManualDecimal() {
        struct Row { let price: Double; let fee: Double }
        let rows = [
            Row(price: 24.99, fee: 3.25),
            Row(price: 19.95, fee: 2.89),
            Row(price: 149.99, fee: 18.00),
            Row(price: 0.99, fee: 0.30),
        ]
        let revenue = Money.sumDecimal(rows.map(\.price))
        let fees = Money.sumDecimal(rows.map(\.fee))
        XCTAssertEqual(revenue, Decimal(string: "195.92"))
        XCTAssertEqual(fees, Decimal(string: "24.44"))
        // Net via the projection overload.
        XCTAssertEqual(Money.sum(rows) { $0.price - $0.fee }, 171.48, accuracy: 0.0001)
    }

    func test_currencyDouble_roundsToCents() {
        XCTAssertEqual(Decimal(string: "0.30")!.currencyDouble, 0.30, accuracy: 0.0001)
        XCTAssertEqual(Decimal(string: "171.485")!.currencyDouble, 171.49, accuracy: 0.0001)
        XCTAssertEqual(Decimal.zero.currencyDouble, 0.0, accuracy: 0.0001)
    }
}
