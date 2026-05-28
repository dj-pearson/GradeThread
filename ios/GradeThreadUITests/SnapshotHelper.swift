//
//  SnapshotHelper.swift
//  Example
//
//  Created by Felix Krause on 10/8/15.
//
//  Vendored from fastlane snapshot (https://docs.fastlane.tools/actions/snapshot/).
//  Do not edit by hand — re-copy from fastlane if you bump the snapshot
//  action. The `screenshots` lane in fastlane/Fastfile drives this.

import Foundation
import XCTest

var deviceLanguage = ""
var locale = ""

func setupSnapshot(_ app: XCUIApplication, waitForAnimations: Bool = true) {
    Snapshot.setupSnapshot(app, waitForAnimations: waitForAnimations)
}

func snapshot(_ name: String, waitForLoadingIndicator: Bool) {
    if waitForLoadingIndicator {
        Snapshot.snapshot(name)
    } else {
        Snapshot.snapshot(name, timeWaitingForIdle: 0)
    }
}

func snapshot(_ name: String, timeWaitingForIdle timeout: TimeInterval = 20) {
    Snapshot.snapshot(name, timeWaitingForIdle: timeout)
}

enum SnapshotError: Error, CustomDebugStringConvertible {
    case cannotFindSimulatorHomeDirectory
    case cannotRunOnPhysicalDevice

    var debugDescription: String {
        switch self {
        case .cannotFindSimulatorHomeDirectory:
            return "Couldn't find simulator home location. Please, check SIMULATOR_HOST_HOME env variable."
        case .cannotRunOnPhysicalDevice:
            return "Can't use Snapshot on a physical device."
        }
    }
}

@objcMembers
open class Snapshot: NSObject {
    static var app: XCUIApplication?
    static var waitForAnimations = true
    static var cacheDirectory: URL?
    static var screenshotsDirectory: URL? {
        return cacheDirectory?.appendingPathComponent("screenshots", isDirectory: true)
    }

    open class func setupSnapshot(_ app: XCUIApplication, waitForAnimations: Bool = true) {
        Snapshot.app = app
        Snapshot.waitForAnimations = waitForAnimations

        do {
            let cacheDir = try getCacheDirectory()
            Snapshot.cacheDirectory = cacheDir
            setLanguage(app)
            setLocale(app)
            setLaunchArguments(app)
        } catch let error {
            NSLog(error.localizedDescription)
        }
    }

    class func setLanguage(_ app: XCUIApplication) {
        guard let cacheDirectory = self.cacheDirectory else {
            NSLog("CacheDirectory is not set - probably running on a physical device?")
            return
        }

        let path = cacheDirectory.appendingPathComponent("language.txt")

        do {
            let trimCharacterSet = CharacterSet.whitespacesAndNewlines
            deviceLanguage = try String(contentsOf: path, encoding: .utf8).trimmingCharacters(in: trimCharacterSet)
            app.launchArguments += ["-AppleLanguages", "(\(deviceLanguage))"]
        } catch {
            NSLog("Couldn't detect/set language...")
        }
    }

    class func setLocale(_ app: XCUIApplication) {
        guard let cacheDirectory = self.cacheDirectory else {
            NSLog("CacheDirectory is not set - probably running on a physical device?")
            return
        }

        let path = cacheDirectory.appendingPathComponent("locale.txt")

        do {
            let trimCharacterSet = CharacterSet.whitespacesAndNewlines
            locale = try String(contentsOf: path, encoding: .utf8).trimmingCharacters(in: trimCharacterSet)
        } catch {
            NSLog("Couldn't detect/set locale...")
        }

        if locale.isEmpty && !deviceLanguage.isEmpty {
            locale = Locale(identifier: deviceLanguage).identifier
        }

        if !locale.isEmpty {
            app.launchArguments += ["-AppleLocale", "\"\(locale)\""]
        }
    }

    class func setLaunchArguments(_ app: XCUIApplication) {
        guard let cacheDirectory = self.cacheDirectory else {
            NSLog("CacheDirectory is not set - probably running on a physical device?")
            return
        }

        let path = cacheDirectory.appendingPathComponent("snapshot-launch_arguments.txt")
        app.launchArguments += ["-FASTLANE_SNAPSHOT", "YES", "-ui_testing"]

        do {
            let launchArguments = try String(contentsOf: path, encoding: String.Encoding.utf8)
            let regex = try NSRegularExpression(pattern: "(\\\".+?\\\"|\\S+)", options: [])
            let matches = regex.matches(in: launchArguments, options: [], range: NSRange(location: 0, length: launchArguments.count))
            let results = matches.map { result -> String in
                (launchArguments as NSString).substring(with: result.range)
            }
            app.launchArguments += results
        } catch {
            NSLog("Couldn't detect/set launch_arguments...")
        }
    }

    open class func snapshot(_ name: String, timeWaitingForIdle timeout: TimeInterval = 20) {
        if timeout > 0 {
            waitForLoadingIndicatorToDisappear(within: timeout)
        }

        NSLog("snapshot: \(name)")

        if Snapshot.waitForAnimations {
            sleep(1)
        }

        #if os(OSX)
            guard let app = self.app else {
                NSLog("XCUIApplication is not set. Please call setupSnapshot(app) before snapshot().")
                return
            }
            app.typeKey(XCUIKeyboardKey.f1, modifierFlags: [.command, .control, .option])
        #else
            guard self.app != nil else {
                NSLog("XCUIApplication is not set. Please call setupSnapshot(app) before snapshot().")
                return
            }
            let screenshot = XCUIScreen.main.screenshot()
            #if os(iOS) && !targetEnvironment(macCatalyst)
                let image = XCUIDevice.shared.orientation.isLandscape ? fixLandscapeOrientation(image: screenshot.image) : screenshot.image
            #else
                let image = screenshot.image
            #endif

            guard var simulator = ProcessInfo().environment["SIMULATOR_DEVICE_NAME"], let screenshotsDir = screenshotsDirectory else { return }

            do {
                let regex = try NSRegularExpression(pattern: "[^A-Za-z0-9_-]+")
                let range = NSRange(location: 0, length: simulator.count)
                simulator = regex.stringByReplacingMatches(in: simulator, range: range, withTemplate: "_")

                let path = screenshotsDir.appendingPathComponent("\(simulator)-\(name).png")
                #if swift(<5.0)
                    UIImagePNGRepresentation(image)?.write(to: path, options: .atomic)
                #else
                    try image.pngData()?.write(to: path, options: .atomic)
                #endif
            } catch let error {
                NSLog("Problem writing screenshot: \(name) to \(screenshotsDir)/\(simulator)-\(name).png")
                NSLog(error.localizedDescription)
            }
        #endif
    }

    class func fixLandscapeOrientation(image: UIImage) -> UIImage {
        #if os(watchOS)
            return image
        #else
            if #available(iOS 10.0, *) {
                let format = UIGraphicsImageRendererFormat()
                format.scale = image.scale
                let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
                return renderer.image { context in
                    image.draw(in: context.format.bounds)
                }
            } else {
                return image
            }
        #endif
    }

    class func waitForLoadingIndicatorToDisappear(within timeout: TimeInterval) {
        #if os(tvOS)
            return
        #else
            guard let app = self.app else {
                NSLog("XCUIApplication is not set. Please call setupSnapshot(app) before snapshot().")
                return
            }

            let networkLoadingIndicator = app.otherElements.deviceStatusBars.networkLoadingIndicators.element
            let networkLoadingIndicatorDisappeared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: networkLoadingIndicator)
            _ = XCTWaiter.wait(for: [networkLoadingIndicatorDisappeared], timeout: timeout)
        #endif
    }

    class func getCacheDirectory() throws -> URL {
        let cachePath = "Library/Caches/tools.fastlane"
        #if arch(i386) || arch(x86_64) || arch(arm64)
            guard let simulatorHostHome = ProcessInfo().environment["SIMULATOR_HOST_HOME"] else {
                throw SnapshotError.cannotFindSimulatorHomeDirectory
            }
            let homeDir = URL(fileURLWithPath: simulatorHostHome)
            return homeDir.appendingPathComponent(cachePath)
        #else
            throw SnapshotError.cannotRunOnPhysicalDevice
        #endif
    }
}

private extension XCUIElementQuery {
    var networkLoadingIndicators: XCUIElementQuery {
        let isNetworkLoadingIndicator = NSPredicate { evaluatedObject, _ in
            guard let element = evaluatedObject as? XCUIElementAttributes else { return false }
            return element.identifier == "InProgress"
        }
        return self.containing(isNetworkLoadingIndicator)
    }

    var deviceStatusBars: XCUIElementQuery {
        guard let app = Snapshot.app else {
            fatalError("XCUIApplication is not set. Please call setupSnapshot(app) before snapshot().")
        }

        let deviceWidth = app.windows.firstMatch.frame.width
        let isStatusBar = NSPredicate { evaluatedObject, _ in
            guard let element = evaluatedObject as? XCUIElementAttributes else { return false }
            return element.frame.minX == 0.0 && element.frame.minY == 0.0 && element.frame.width == deviceWidth && element.frame.height <= 60.0
        }
        return self.containing(isStatusBar)
    }
}

private extension CGFloat {
    func isBetween(_ numberA: CGFloat, and numberB: CGFloat) -> Bool {
        return numberA...numberB ~= self
    }
}
