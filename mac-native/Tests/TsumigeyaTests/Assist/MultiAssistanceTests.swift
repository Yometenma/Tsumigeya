import Foundation
import Testing
@testable import TsumigeyaCore

private struct MultiFixture {
    let root: URL
    let p: AssistanceProject
    init(_ engine: String) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("multi-assist-\(UUID())")
        self.root = root
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        func write(_ path: String, _ text: String) throws {
            let url = root.appendingPathComponent(path)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url)
        }
        if engine == "renpy" {
            try fm.createDirectory(at: root.appendingPathComponent("renpy"), withIntermediateDirectories: true)
            try write("game/script.rpy", "label start:\n    e \"こんにちは [name] {b}勇者{/b}\"\n    return\n")
        } else if engine == "tyrano" {
            try write("package.json", #"{"main":"index.html"}"#)
            try write("index.html", "<html><head></head><body></body></html>")
            try write("tyrano/plugins/kag/kag.js", "// official engine signature fixture")
            try write("data/scenario/first.ks", "こんにちは[p]\n[iscript]\nsecret='no';\n[endscript]\n次の台詞[r]")
        } else {
            try write("Game.ini", "[Game]\r\nLibrary=RGSS301.dll\r\nScripts=Data\\Scripts.\(engine)\r\nTitle=original\r\n")
            try write("Data/Scripts.\(engine)", "fixture script identity")
        }
        p = try AssistanceProject.detect(folder: root.path)
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
}

@Suite("多引擎辅助接入与文件桥安全")
struct MultiAssistanceTests {
    @Test("五种新增接入独立开关、保留词典、恢复不动原始数据", arguments: ["rxdata", "rvdata", "rvdata2", "renpy", "tyrano"])
    func roundtrip(_ kind: String) throws {
        let f = try MultiFixture(kind); defer { f.clean() }
        let old = try? Data(contentsOf: f.p.page)
        try AssistanceInstaller.configure(f.p, options: .init(translation: true), translations: ["こんにちは":"你好"], running: false)
        #expect(try AssistanceInstaller.options(f.p) == .init(translation: true))
        try AssistanceInstaller.configure(f.p, options: .init(cheats: true), running: false)
        #expect(try AssistanceInstaller.options(f.p) == .init(cheats: true))
        let dir = AssistanceInstaller.location(f.p)
        let dictionary = try JSONDecoder().decode([String:String].self, from: Data(contentsOf: dir.appendingPathComponent("translations.json")))
        #expect(dictionary["こんにちは"] == "你好")
        if f.p.usesFileBridge {
            let optionsFile = dir.appendingPathComponent("config.json")
            var raw = try JSONDecoder().decode([String:JSONValue].self, from: Data(contentsOf: optionsFile))
            raw["future"] = .object(["keep":.bool(true)])
            try JSONEncoder().encode(raw).write(to: optionsFile)
            try AssistanceInstaller.configure(f.p, options: .init(translation:true,cheats:true), running:false)
            let preserved = try JSONDecoder().decode([String:JSONValue].self, from: Data(contentsOf: optionsFile))
            #expect(preserved["future"] == raw["future"])
        }
        try AssistanceInstaller.restore(f.p, running:false)
        #expect(!FileManager.default.fileExists(atPath:dir.path))
        #expect((try? Data(contentsOf:f.p.page)) == old)
    }
    @Test("入口碰撞、脚本外改与未知文件拒绝清理")
    func ownership() throws {
        let f = try MultiFixture("renpy"); defer { f.clean() }
        try Data("user script".utf8).write(to:f.p.page)
        #expect(throws:(any Error).self) { try AssistanceInstaller.configure(f.p,options:.init(cheats:true),running:false) }
        #expect(try Data(contentsOf:f.p.page) == Data("user script".utf8))
        try FileManager.default.removeItem(at:f.p.page)
        try AssistanceInstaller.configure(f.p,options:.init(cheats:true),running:false)
        let unknown = AssistanceInstaller.location(f.p).appendingPathComponent("private.txt")
        try Data("keep".utf8).write(to:unknown)
        #expect(throws:(any Error).self) { try AssistanceInstaller.restore(f.p,running:false) }
        #expect(FileManager.default.fileExists(atPath:f.p.page.path))
        try FileManager.default.removeItem(at:unknown)
        let source = AssistanceInstaller.location(f.p).appendingPathComponent("renpy.py")
        try Data("changed".utf8).write(to:source)
        #expect(throws:(any Error).self) { try AssistanceInstaller.configure(f.p,options:.init(),running:false) }
        #expect(throws:(any Error).self) { try AssistanceInstaller.restore(f.p,running:false) }
    }
    @Test("文件桥只发送当前会话的命令，拒绝过期和符号链接")
    func bridge() throws {
        let f = try MultiFixture("renpy"); defer { f.clean() }
        try AssistanceInstaller.configure(f.p,options:.init(cheats:true),running:false)
        let dir = AssistanceInstaller.location(f.p), stateFile=dir.appendingPathComponent("state.json")
        var snapshot=AssistanceSnapshot(identity:f.p.identity,session:"current",updated:Date.now.timeIntervalSince1970,ready:true,variables:[.init(key:"money",name:"money",value:.int(10),locked:false)])
        try JSONEncoder().encode(snapshot).write(to:stateFile)
        let loaded=try AssistanceBridge.read(f.p)
        let id=try AssistanceBridge.send(f.p,snapshot:loaded,action:"set",key:"money",value:.int(20))
        let command=try JSONDecoder().decode([String:JSONValue].self,from:Data(contentsOf:dir.appendingPathComponent("command.json")))
        #expect(command["id"]?.stringValue == id); #expect(command["session"]?.stringValue == "current")
        snapshot.session="new";try JSONEncoder().encode(snapshot).write(to:stateFile)
        #expect(throws:(any Error).self) { try AssistanceBridge.send(f.p,snapshot:loaded,action:"set",key:"money",value:.int(20)) }
        snapshot.updated -= 20; try JSONEncoder().encode(snapshot).write(to:stateFile)
        #expect(throws:(any Error).self) { try AssistanceBridge.read(f.p) }
        try FileManager.default.removeItem(at:stateFile)
        try FileManager.default.createSymbolicLink(at:stateFile,withDestinationURL:f.p.page)
        #expect(throws:(any Error).self) { try AssistanceBridge.read(f.p) }
    }
    @Test("保留 RenPy 插值和文本标签，不翻译脚本参数或新译文")
    func extraction() throws {
        #expect(AdditionalTextExtractor.renpy("e \"こんにちは [name] {b}勇者{/b}\"\n$ secret = \"no\"\nnew \"already translated\"\nplay music \"theme.ogg\"\n\"選択肢\":") == ["こんにちは [name] {b}勇者{/b}", "選択肢"])
        #expect(throws:(any Error).self) {try TranslationTokens.validate(source:"Hello [name] {b}hero{/b} %s",target:"你好 {b}勇者{/b} %s")}
        try TranslationTokens.validate(source:"Hello [name] {b}hero{/b} %s",target:"你好 [name] {b}勇者{/b} %s")
        #expect(TranslationTokens.tokens("Hello {{name}}") == ["{{name}}"])
        #expect(throws: (any Error).self) { try TranslationTokens.validate(source: "Hello {{name}}", target: "你好 {name}") }
        try TranslationTokens.validate(source: "Hello {{name}}", target: "你好 {{name}}")
        #expect(AdditionalTextExtractor.tyrano("; comment\n*label\n[iscript]\nsecret='no'\n[endscript]\nこんにちは[p]\n次の台詞[r]") == ["こんにちは","次の台詞"])
    }
    @Test("RGSS 预加载跟随安装且不要求修改 Game.ini")
    func preload() throws {
        let f=try MultiFixture("rvdata2");defer{f.clean()}
        #expect(try NativeAssistance.preload(for:f.root.path) == nil)
        try AssistanceInstaller.configure(f.p,options:.init(translation:true),running:false)
        #expect(try NativeAssistance.preload(for:f.root.path)?.hasSuffix(".tsumigeya-assist/rgss.rb") == true)
        try AssistanceInstaller.restore(f.p,running:false)
        #expect(try NativeAssistance.preload(for:f.root.path) == nil)
    }
    @Test("Ren’Py 编译不改变游戏身份，源码变动会改变身份")
    func renpyIdentity() throws {
        let f = try MultiFixture("renpy"); defer { f.clean() }
        let game = f.p.content
        try Data("compiled".utf8).write(to: game.appendingPathComponent("script.rpyc"))
        #expect(try AssistanceProject.detect(folder: f.root.path).identity == f.p.identity)
        try AssistanceInstaller.configure(f.p, options: .init(cheats: true), running: false)
        try Data("compiled helper".utf8).write(to: f.p.page.deletingPathExtension().appendingPathExtension("rpyc"))
        #expect(try AssistanceProject.detect(folder: f.root.path).identity == f.p.identity)
        try Data("label start:\n    \"Changed\"\n".utf8).write(to: game.appendingPathComponent("script.rpy"))
        #expect(try AssistanceProject.detect(folder: f.root.path).identity != f.p.identity)
        #expect(throws: (any Error).self) { try AssistanceInstaller.configure(f.p, options: .init(), running: false) }
    }
    @Test("不把 Python、界面和多行字符串块当作 Ren’Py 台词")
    func renpyBlocks() {
        let source = "init python:\n    \"code docstring\"\n    value = 1\nlabel start:\n    e \"Dialogue\"\n    python:\n        \"not dialogue\"\n    \"Narration\"\nscreen example():\n    \"not dialogue\""
        #expect(AdditionalTextExtractor.renpy(source) == ["Dialogue", "Narration"])
    }
    @Test("Ren’Py 子目录源码参与身份校验")
    func nestedRenpyIdentity() throws {
        let f = try MultiFixture("renpy"); defer { f.clean() }
        let nested = f.p.content.appendingPathComponent("chapters")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        let source = nested.appendingPathComponent("chapter.rpy")
        try Data("label chapter:\n    \"Chapter\"\n".utf8).write(to: source)
        let next = try AssistanceProject.detect(folder: f.root.path)
        #expect(next.identity != f.p.identity)
        try Data("compiled".utf8).write(to: source.deletingPathExtension().appendingPathExtension("rpyc"))
        #expect(try AssistanceProject.detect(folder: f.root.path).identity == next.identity)
    }
    @Test("辅助备份符号链接拒绝覆盖外部文件")
    func backupSafety() throws {
        let f = try MultiFixture("renpy"); defer { f.clean() }
        try AssistanceInstaller.configure(f.p, options: .init(cheats: true), running: false)
        let outside = f.root.appendingPathComponent("unrelated")
        let sentinel = Data("keep".utf8); try sentinel.write(to: outside)
        let backup = AssistanceInstaller.location(f.p).appendingPathComponent("config.json.bak")
        try FileManager.default.createSymbolicLink(at: backup, withDestinationURL: outside)
        #expect(throws: (any Error).self) { try AssistanceInstaller.configure(f.p, options: .init(translation: true), running: false) }
        #expect(try Data(contentsOf: outside) == sentinel)
        #expect(try AssistanceInstaller.options(f.p) == .init(cheats: true))
    }
    @Test("启动配置追加辅助且保留兼容预加载，卸载后不再加载")
    func launchPreloads() throws {
        let f = try MultiFixture("rvdata2"); defer { f.clean() }
        let data = f.p.root.appendingPathComponent("launcher-data").path
        let original = "/isolated/kawariki/preload.rb"
        let context = LaunchContext(folder: f.p.root.path, gamePath: f.p.root.appendingPathComponent("Game.exe").path,
            gameArgs: ["preloadScript": .array([.string(original)])], gameTitle: "验收", dataDir: data, arch: "arm64")
        try AssistanceInstaller.configure(f.p, options: .init(cheats: true), running: false)
        guard case .success = LaunchPlanner.plan(engine: "mkxpz", context: context, fileExists: { _ in true }) else { Issue.record("安装辅助后计划失败"); return }
        let file = URL(fileURLWithPath: BinaryPaths.mkxpzConfigPath(data))
        let installed = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: file))
        #expect(installed["preloadScript"]?.arrayValue?.compactMap(\.stringValue) == [original, AssistanceInstaller.location(f.p).appendingPathComponent("rgss.rb").path])
        try AssistanceInstaller.restore(f.p, running: false)
        guard case .success = LaunchPlanner.plan(engine: "mkxpz", context: context, fileExists: { _ in true }) else { Issue.record("卸载辅助后计划失败"); return }
        let restored = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: file))
        #expect(restored["preloadScript"] == .array([.string(original)]))
    }
    @Test("相同 Tyrano 引擎替换剧情后不复用旧游戏身份")
    func tyranoIdentity() throws {
        let f = try MultiFixture("tyrano"); defer { f.clean() }
        try AssistanceInstaller.configure(f.p, options: .init(translation: true), running: false)
        #expect(try AssistanceProject.detect(folder: f.root.path).identity == f.p.identity)
        let scenario = f.p.content.appendingPathComponent("data/scenario/first.ks")
        try Data("Replacement dialogue[p]".utf8).write(to: scenario)
        #expect(try AssistanceProject.detect(folder: f.root.path).identity != f.p.identity)
        #expect(throws: (any Error).self) { try AssistanceInstaller.configure(f.p, options: .init(), running: false) }
    }
    @Test("启动、翻译、作弊能力不混为一谈")
    func capabilities() {
        #expect(EngineCapabilities.forEngine("unity").translation == "未接入")
        #expect(EngineCapabilities.forEngine("easyrpg").cheats == "未接入")
        #expect(EngineCapabilities.forEngine("nwjs").translation.contains("MV/MZ"))
        #expect(EngineCapabilities.forEngine("renpy").cheats.contains("变量"))
    }
}
