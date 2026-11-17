import Foundation
import Testing
@testable import TsumigeyaCore

private struct ModuleFixture {
    let root: URL
    init(_ kind: String) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("module-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if kind == "renpy" {
            try FileManager.default.createDirectory(at: root.appendingPathComponent("renpy"), withIntermediateDirectories: true)
            try write("game/script.rpy", "label start:\n    \"台詞\"\n")
        } else if ["xp", "vx", "ace"].contains(kind) {
            let ext = ["xp": "rxdata", "vx": "rvdata", "ace": "rvdata2"][kind]!
            try write("Game.ini", "[Game]\r\nScripts=Data\\Scripts.\(ext)\r\n")
            try write("Data/Scripts.\(ext)", "original script")
        } else {
            let prefix = kind == "mv" ? "www/" : ""
            try write("package.json", "{\"main\":\"\(prefix)index.html\"}")
            try write(prefix + "index.html", "<html><body></body></html>")
            if kind == "tyrano" {
                try write("tyrano/plugins/kag/kag.js", "// engine")
                try write("data/scenario/first.ks", "台詞[p]\n[iscript]\nsecret='not dialogue';\n[endscript]")
            } else {
                try write(prefix + "js/" + (kind == "mv" ? "rpg_core.js" : "rmmz_core.js"), "// engine")
                try write(prefix + "data/System.json", "{\"gameTitle\":\"台詞\"}")
            }
        }
    }
    func write(_ path: String, _ value: String) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(value.utf8).write(to: url)
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
}

@Suite("内置辅助模块与旧入口兼容")
struct AssistanceModuleTests {
    @Test("四类模块注册完整且能力页使用同一份声明")
    func registration() throws {
        let available = AssistanceModules.available
        #expect(available.count == AssistanceEngine.allCases.count)
        #expect(Set(available.map(\.id)) == Set(AssistanceEngine.allCases))
        #expect(Set(available.map(\.runtime)).count == available.count)
        for info in available {
            #expect(AssistanceModules.forEngine(info.id).runtime == info.runtime)
            #expect(AssistanceModules.forRuntime(info.runtime)?.id == info.id)
            #expect(EngineCapabilities.forEngine(info.runtime).translation == info.translation)
            #expect(EngineCapabilities.forEngine(info.runtime).cheats == info.cheats)
            #expect(!info.installationNote.isEmpty && !info.cheatInstructions.isEmpty)
        }
        for runtime in ["easyrpg", "kirikiri", "onscripter", "siglus", "godot", "unity", "bakin", "wolf", "unknown"] {
            #expect(AssistanceModules.forRuntime(runtime) == nil)
            #expect(EngineCapabilities.forEngine(runtime).translation == "未接入")
            #expect(EngineCapabilities.forEngine(runtime).cheats == "未接入")
        }
    }

    @Test("七种项目经模块提取、选取脚本并保留旧配置和词典", arguments: ["mv", "mz", "xp", "vx", "ace", "renpy", "tyrano"])
    func dispatch(_ kind: String) throws {
        let f = try ModuleFixture(kind); defer { f.clean() }
        let project = try AssistanceProject.detect(folder: f.root.path)
        let expected: AssistanceEngine = kind == "renpy" ? .renpy : kind == "tyrano" ? .tyrano : ["mv", "mz"].contains(kind) ? .rpgMaker : .rgss
        #expect(project.engine == expected)
        #expect(project.module.id == expected)
        #expect(project.usesFileBridge == [.rgss, .renpy].contains(expected))
        let original = try? Data(contentsOf: project.page)
        try AssistanceInstaller.configure(project, options: .init(translation: true), translations: ["台詞": "译文"], running: false)
        let location = AssistanceInstaller.location(project)
        let expectedResources: [String: String]
        if expected == .rgss { expectedResources = ["rgss.rb": "rgss.rb"] }
        else if expected == .renpy { expectedResources = ["renpy.py": "renpy.py"] }
        else { expectedResources = ["loader.js": "loader.js", "translation.js": kind == "tyrano" ? "tyrano-translation.js" : "translation.js", "cheats.js": kind == "tyrano" ? "tyrano-cheats.js" : "cheats.js", "panel.js": kind == "tyrano" ? "tyrano-panel.js" : "panel.js"] }
        for (file, resource) in expectedResources {
            #expect(try Data(contentsOf: location.appendingPathComponent(file)) == AssistanceInstaller.resource(resource))
        }
        if expected == .rgss { try Data("[\"台詞\"]".utf8).write(to: location.appendingPathComponent("extracted.json")) }
        let entries = try AssistanceModules.extract(project)
        #expect(entries.map(\.source) == ["台詞"])
        #expect(try RPGTextExtractor.extract(project).map(\.source) == entries.map(\.source))
        #expect(try AdditionalTextExtractor.extract(project).map(\.source) == entries.map(\.source))
        let config = location.appendingPathComponent("config.json")
        var raw = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: config))
        raw["future"] = .object(["preserve": .bool(true)])
        try JSONEncoder().encode(raw).write(to: config)
        try AssistanceInstaller.configure(project, options: .init(cheats: true), running: false)
        #expect(try AssistanceInstaller.options(project) == .init(cheats: true))
        let after = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: config))
        #expect(after["future"] == raw["future"])
        #expect(try JSONDecoder().decode([String: String].self, from: Data(contentsOf: location.appendingPathComponent("translations.json"))) == ["台詞": "译文"])
        #expect(try AssistanceProject.detect(folder: f.root.path) == project)
        try AssistanceInstaller.restore(project, running: false)
        #expect((try? Data(contentsOf: project.page)) == original)
        #expect(!FileManager.default.fileExists(atPath: location.path))
    }

    @Test("原生项目优先于残留网页入口，不因模块拆分改变识别结果", arguments: ["xp", "renpy"])
    func priority(_ kind: String) throws {
        let f = try ModuleFixture(kind); defer { f.clean() }
        let before = try AssistanceProject.detect(folder: f.root.path)
        try f.write("package.json", "broken leftover")
        #expect(try AssistanceProject.detect(folder: f.root.path) == before)
    }

    @Test("运行进程判定跟随模块，错误引擎或其他游戏不算运行")
    func processMatching() throws {
        let f = try ModuleFixture("xp"); defer { f.clean() }
        let project = try AssistanceProject.detect(folder: f.root.path)
        let rpg = AssistanceModules.module(for: .rpgMaker)
        let renpy = AssistanceModules.module(for: .renpy)
        let tyrano = AssistanceModules.module(for: .tyrano)
        #expect(rpg.matchesProcess("/runtime/nwjs " + f.root.path, project: project))
        #expect(tyrano.matchesProcess("/runtime/nwjs " + f.root.path, project: project))
        #expect(!rpg.matchesProcess("/runtime/python " + f.root.path, project: project))
        #expect(renpy.matchesProcess("/runtime/python " + f.root.path, project: project))
        #expect(!renpy.matchesProcess("/runtime/nwjs " + f.root.path, project: project))
        #expect(!renpy.matchesProcess("/runtime/python /another/game", project: project))
        try f.write("mkxp.app/Contents/Game/mkxp.json", String(decoding: JSONEncoder().encode(["gameFolder": f.root.path]), as: UTF8.self))
        let command = f.root.appendingPathComponent("mkxp.app/Contents/MacOS/mkxp-z").path
        let rgss = AssistanceModules.module(for: .rgss)
        #expect(rgss.matchesProcess(command, project: project))
        try f.write("mkxp.app/Contents/Game/mkxp.json", "{\"gameFolder\":\"/another/game\"}")
        #expect(!rgss.matchesProcess(command, project: project))
        try f.write("mkxp.app/Contents/Game/mkxp.json", "broken")
        #expect(!rgss.matchesProcess(command, project: project))
    }

    @Test("识别到损坏项目不得跳过错误改认其他模块")
    func failClosed() throws {
        let f = try ModuleFixture("tyrano"); defer { f.clean() }
        try f.write("Game.ini", "[Game]\nScripts=Data\\Scripts.rxdata\n")
        #expect(throws: (any Error).self) { try AssistanceProject.detect(folder: f.root.path) }
        try FileManager.default.removeItem(at: f.root.appendingPathComponent("Game.ini"))
        try f.write("js/rpg_core.js", "// broken Maker signature without database")
        #expect(throws: (any Error).self) { try AssistanceProject.detect(folder: f.root.path) }
    }
}
