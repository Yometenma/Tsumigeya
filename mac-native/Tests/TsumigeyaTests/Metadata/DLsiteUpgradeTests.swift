import Foundation
import Testing
@testable import TsumigeyaCore

@Suite("增强刮削：新旧页面与数据保真")
struct DLsiteUpgradeTests {
    func fixture() throws -> String {
        let url = try #require(Bundle.module.url(forResource: "dlsite-modern-RJ331590", withExtension: "html"))
        return try String(contentsOf: url, encoding: .utf8)
    }

    @Test("真实新页面取得完整介绍、日期、标签、语言、系列和截图")
    func modernPage() throws {
        let html = try fixture()
        #expect(DLsiteParser.extractContentsJSON(html) == nil)
        let work = try #require(DLsiteParser.parseWork(from: html, rj: "RJ331590", fetchedAt: "test"))
        #expect(work.circle == "Remtairy (レムテイリー)")
        #expect(work.workType == "RPG")
        #expect(work.releaseDate == "2021-12-17")
        #expect(work.category == "maniax")
        #expect(work.series == "カリンズ・プリズン")
        #expect(work.languages.contains("CHI_HANS"))
        #expect(work.tags.count == 5)
        #expect(work.sampleImageURLs.count == 10)
        #expect(work.creators.contains("Remtairy"))
        #expect(!work.voiceActors.isEmpty)
        #expect(work.supportedSystems?.contains("Windows") == true)
        let description = try #require(work.description)
        #expect(description.count > 1000)
        #expect(!description.contains("<br"))
        #expect(!description.contains("\r"))
        #expect(description.contains("\n"))
        #expect(DLsiteParser.parseWork(from: html, rj: "RJ999999", fetchedAt: "test") == nil)
    }

    @Test("一般向真实新页面正确处理无系列、空标签和单一语言")
    func generalPage() throws {
        let url = try #require(Bundle.module.url(forResource: "dlsite-modern-RJ118525", withExtension: "html"))
        let html = try String(contentsOf: url, encoding: .utf8)
        let work = try #require(DLsiteParser.parseWork(from: html, rj: "RJ118525", fetchedAt: "test"))
        #expect(work.title == "東方の迷宮2")
        #expect(work.circle == "偽英国紳士団")
        #expect(work.category == "home")
        #expect(work.ageRating == "general")
        #expect(work.releaseDate == "2013-08-17")
        #expect(work.languages == ["JPN"])
        #expect(work.series == nil)
        #expect(work.tags.isEmpty)
        #expect(work.sampleImageURLs.count == 3)
        #expect((work.description?.count ?? 0) > 300)
    }

    @Test("错误分区路径返回全年龄详情时优先作品自身分区")
    func intrinsicCategory() throws {
        let url = try #require(Bundle.module.url(forResource: "dlsite-modern-RJ118525", withExtension: "html"))
        let html = try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "/home/", with: "/maniax/")
        let work = try #require(DLsiteParser.parseWork(from: html, rj: "RJ118525", fetchedAt: "test"))
        #expect(work.category == "home")
        #expect(work.ageRating == "general")
    }

    @Test("JSON-LD 可独立兜底，错误作品和泛站点 meta 不被认作成功")
    func linkedData() throws {
        let html = """
        <script type="application/ld+json">{"@graph":[{"@type":"Product","sku":"RJ123456","name":"作品","brand":{"name":"社团"},"image":["https://img.dlsite.jp/cover.jpg","https://evil.example/a.jpg","//img.dlsite.jp/sample.jpg"],"offers":{"url":"https://www.dlsite.com/home/work/=/product_id/RJ123456.html"}}]}</script>
        """
        let work = try #require(DLsiteParser.parseWork(from: html, rj: "RJ123456", fetchedAt: "test"))
        #expect(work.category == "home")
        #expect(work.sampleImageURLs == ["https://img.dlsite.jp/sample.jpg"])
        #expect(DLsiteParser.parseWork(from: html, rj: "RJ123457", fetchedAt: "test") == nil)
        #expect(DLsiteParser.parseWork(from: "<meta property=\"og:title\" content=\"DLsite 首页\">", rj: "RJ123456", fetchedAt: "test") == nil)
    }

    @Test("统一输入解析链接，拒绝伪站点和任意地址")
    func input() {
        #expect(DlsiteLookup.workReference(" rj-123456 ")?.rj == "RJ123456")
        #expect(DlsiteLookup.workReference("https://www.dlsite.com/home/work/=/product_id/RJ123456.html/?locale=zh_CN")?.category == "home")
        #expect(DlsiteLookup.workReference("https://www.dlsite.com.evil.example/home/RJ123456.html") == nil)
        #expect(DlsiteLookup.workReference("file:///home/RJ123456.html") == nil)
        #expect(DlsiteLookup.workReference("https://example.com/RJ123456") == nil)
        #expect(DlsiteLookup.keywordVariants("Game_Title [简体汉化版]").contains("Game Title"))
        #expect(DlsiteLookup.keywordVariants("魔法少女の冒険") == ["魔法少女の冒険"])
    }

    @Test("扩展字段在缓存和游戏元数据中往返，旧文件默认空集合")
    func persistence() throws {
        let work = try #require(DLsiteParser.parseWork(from: fixture(), rj: "RJ331590", fetchedAt: "test"))
        let meta = GameDlsiteMeta(work: work, editedFields: ["description"])
        #expect(try JSONDecoder().decode(GameDlsiteMeta.self, from: JSONEncoder().encode(meta)) == meta)
        let cached = CachedWork(work: work, cachedAt: 123)
        #expect(try JSONDecoder().decode(CachedWork.self, from: JSONEncoder().encode(cached)).work == work)
        let old = Data(#"{"rj":"RJ123456","fetchedAt":"old"}"#.utf8)
        #expect(try JSONDecoder().decode(GameDlsiteMeta.self, from: old).work.tags.isEmpty)
        #expect(try JSONDecoder().decode(GameDlsiteMeta.self, from: old).work.sampleImageURLs.isEmpty)
    }

    @Test("写入扩展信息保留分类与未知字段，清空已知字段不残留")
    func unknownFields() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("library-meta.json")
        let original = Data(#"{"categories":{"x":{"name":"分类"}},"assignments":{"1":["x"]},"1":{"future":true,"dlsite":{"rj":"RJ123456","fetchedAt":"old","tags":["旧标签"],"futureField":7}}}"#.utf8)
        try original.write(to: url)
        let meta = GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", fetchedAt: "test"))
        #expect(GameMetaStore.save(dataDir: dir.path, gameId: "1", meta: meta) == nil)
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)).objectValue
        #expect(raw?["categories"]?.objectValue?["x"] != nil)
        #expect(raw?["assignments"]?.objectValue?["1"]?.arrayValue == [.string("x")])
        #expect(raw?["1"]?.objectValue?["dlsite"]?.objectValue?["futureField"] == .int(7))
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1")?.work.tags == [])
    }

    @Test("畸形 Nuxt 引用不能循环或越界")
    func malformedNuxt() {
        let html = #"<script id="__NUXT_DATA__" type="application/json">[{"dlsite-product-RJ123456":1},{"data":1}]</script>"#
        #expect(DLsitePageData.nuxtProduct(html, rj: "RJ123456") == nil)
    }
}

actor DLsiteSequenceTransport: DLsiteTransport {
    var urls: [String] = []
    var starts: [ContinuousClock.Instant] = []
    let responses: [(Int, String)]
    init(_ responses: [(Int, String)]) { self.responses = responses }
    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        try Task.checkCancellation()
        starts.append(.now)
        urls.append(url)
        let response = responses[min(urls.count - 1, responses.count - 1)]
        return (response.0, response.1)
    }
}

@Suite("增强刮削：搜索回退与取消")
struct DLsiteRecoveryTests {
    private let empty = "<title>検索結果</title>"
    private let hit = """
    <title>検索結果</title><div data-list_item_product_id="RJ123456"><dd class="work_name"><span>作品名<a title="作品">表示</a></span></dd></div>
    """

    @Test("空结果跨分类回退并保留候选来源，不自动确认")
    func searchFallback() async throws {
        let fake = DLsiteSequenceTransport([(200, empty), (200, hit)])
        let service = DLsiteService(dataDir: "/unused", transport: fake, minIntervalMs: 0)
        let result = await service.searchAll(keyword: "作品")
        guard case .success(let hits) = result else { Issue.record("应该得到一般向候选"); return }
        #expect(hits.count == 1)
        #expect(hits.first?.category == "home")
        #expect(await fake.urls.count == 2)
    }

    @Test("两个分类确实无结果后才尝试去除汉化后缀的关键词")
    func keywordFallback() async {
        let fake = DLsiteSequenceTransport([(200, empty), (200, empty), (200, hit), (200, empty)])
        let service = DLsiteService(dataDir: "/unused", transport: fake, minIntervalMs: 0)
        guard case .success(let hits) = await service.searchAll(keyword: "Game_Title [简体汉化版]") else {
            Issue.record("应成功回退"); return
        }
        #expect(hits.count == 1)
        let urls = await fake.urls
        #expect(urls.count == 4)
        #expect(urls[2].contains("Game%20Title"))
    }

    @Test("网络错误不伪装成无结果，也不盲目尝试更多关键词")
    func networkFailure() async {
        let fake = DLsiteSequenceTransport([(503, "")])
        let service = DLsiteService(dataDir: "/unused", transport: fake, minIntervalMs: 0)
        #expect(await service.searchAll(keyword: "作品") == .failure(.httpStatus(503)))
        #expect(await fake.urls.count == 2)
    }

    @Test("排队期间取消不会发出第二个请求")
    func cancellation() async throws {
        let fake = DLsiteSequenceTransport([(200, empty)])
        let service = DLsiteService(dataDir: "/unused", transport: fake, minIntervalMs: 800)
        _ = await service.search(keyword: "first")
        let task = Task { await service.search(keyword: "second") }
        try await Task.sleep(for: .milliseconds(40))
        task.cancel()
        #expect(await task.value == .failure(.cancelled))
        #expect(await fake.urls.count == 1)
    }

    @Test("并发搜索的实际发起时间仍遵守间隔")
    func concurrentSpacing() async {
        let fake = DLsiteSequenceTransport([(200, empty)])
        let service = DLsiteService(dataDir: "/unused", transport: fake, minIntervalMs: 80)
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<4 { group.addTask { _ = await service.search(keyword: "\(i)") } }
        }
        let starts = await fake.starts
        #expect(starts.count == 4)
        for pair in zip(starts, starts.dropFirst()) { #expect(pair.0.duration(to: pair.1) >= .milliseconds(78)) }
    }
}

@Suite("增强刮削：缓存安全与扩展字段")
struct DLsiteEnrichmentSafetyTests {
    @Test("旧缓存需要升级，损坏缓存不被刷新覆盖")
    func cacheUpgradeAndCorruption() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("dlsite"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("dlsite/RJ123456.json")
        let old = Data(#"{"rj":"RJ123456","title":"旧摘要","cachedAt":1000,"fetchedAt":"old","future":7}"#.utf8)
        try old.write(to: url)
        let service = DLsiteService(dataDir: dir.path, now: { 1001 })
        let cached = try #require(await service.readCache(rj: "RJ123456"))
        #expect(!(await service.isCacheFresh(cached)))
        let updated = CachedWork(work: DlsiteWork(rj: "RJ123456", title: "新信息", fetchedAt: "new", tags: ["标签"]), cachedAt: 1001)
        #expect(await service.writeCache(updated) == nil)
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        #expect(raw.objectValue?["future"] == .int(7))
        #expect(raw.objectValue?["formatVersion"] == .int(2))
        #expect(try Data(contentsOf: url.appendingPathExtension("bak")) == old)
        let damaged = Data("{损坏的原件".utf8)
        try damaged.write(to: url)
        #expect(await service.writeCache(updated) != nil)
        #expect(try Data(contentsOf: url) == damaged)
        #expect(try Data(contentsOf: url.appendingPathExtension("bak")) == old)
    }

    @Test("备份不可写时缓存原件不变")
    func cacheBackupFailure() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("dlsite"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("dlsite/RJ123456.json")
        let original = Data(#"{"rj":"RJ123456","fetchedAt":"old"}"#.utf8)
        try original.write(to: url)
        try FileManager.default.createDirectory(at: url.appendingPathExtension("bak"), withIntermediateDirectories: true)
        let service = DLsiteService(dataDir: dir.path)
        let updated = CachedWork(work: DlsiteWork(rj: "RJ123456", fetchedAt: "new"), cachedAt: 1001)
        #expect(await service.writeCache(updated) != nil)
        #expect(try Data(contentsOf: url) == original)
    }

    @Test("新增字段的手改刷新保护与换绑隔离")
    func protectedFields() {
        let old = DlsiteWork(rj: "RJ123456", fetchedAt: "old", releaseDate: "自定日期", series: "自定系列",
                            tags: ["自定标签"], languages: ["JPN"], creators: ["自定制作"], voiceActors: ["自定配音"], supportedSystems: "自定系统")
        let incoming = DlsiteWork(rj: "RJ123456", fetchedAt: "new", releaseDate: "新日期", series: "新系列",
                                 tags: ["新标签"], languages: ["ENG"], creators: ["新制作"], voiceActors: ["新配音"], supportedSystems: "新系统")
        let merged = EditedFields.merge(old: old, incoming: incoming, edited: Set(EditedFields.editable))
        #expect(merged.releaseDate == old.releaseDate)
        #expect(merged.series == old.series)
        #expect(merged.tags == old.tags)
        #expect(merged.languages == old.languages)
        #expect(merged.creators == old.creators)
        #expect(merged.voiceActors == old.voiceActors)
        #expect(merged.supportedSystems == old.supportedSystems)
        var other = incoming
        other.rj = "RJ654321"
        #expect(EditedFields.merge(old: old, incoming: other, edited: Set(EditedFields.editable)) == other)
    }

    @Test("社团、标签、系列和编号参与本地库搜索，不依赖联网")
    func metadataSearch() {
        let game = GameRecord(id: "1", gameTitle: "本地中文名", gamePath: "/fixture/Game.exe", gameEngine: "nwjs")
        let work = DlsiteWork(rj: "RJ123456", title: "原始作品名称", circle: "测试社团", fetchedAt: "test", series: "冒险系列", tags: ["角色扮演"])
        for query in ["测试社团", "角色扮演", "冒险系列", "RJ123456", "原始作品名称"] {
            #expect(LibraryFilter.apply(games: [game], searchText: query, onlyUnbound: false,
                                        hasBinding: { _ in true }, metadata: { _ in work }) == [game])
        }
        #expect(LibraryFilter.apply(games: [game], searchText: "不存在的标签", onlyUnbound: false,
                                   hasBinding: { _ in true }, metadata: { _ in work }).isEmpty)
    }

    @Test("非 UTF-8 说明文件和作品快捷链接也能提取 RJ")
    func readmeRecognition() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let data = Data([0x82, 0xa0, 0x82, 0xa2]) + Data(" RJ123456\r\n".utf8)
        try data.write(to: dir.appendingPathComponent("お読みください.txt"))
        try Data("[InternetShortcut]\r\nURL=https://www.dlsite.com/home/work/=/product_id/RJ654321.html".utf8)
            .write(to: dir.appendingPathComponent("作品.url"))
        let rjs = RJNumber.detectFromPath(gamePath: dir.path)
        #expect(rjs.contains("RJ123456"))
        #expect(rjs.contains("RJ654321"))
        #expect(RJNumber.detectFromPath(gamePath: dir.path, maxReadmeFiles: 0).isEmpty)
    }

    @Test("分类部分失败仍返回已找到候选并明确警告")
    func partialSearch() async {
        let html = """
        <title>検索結果</title><div data-list_item_product_id="RJ123456"><dd class="work_name"><a title="候选">候选</a></dd></div>
        """
        let fake = DLsiteSequenceTransport([(200, html), (503, "")])
        let service = DLsiteService(dataDir: "/unused", transport: fake, minIntervalMs: 0)
        guard case .success(let report) = await service.searchReport(keyword: "候选") else {
            Issue.record("不应丢掉已找到的候选"); return
        }
        #expect(report.hits.count == 1)
        #expect(report.warnings.count == 1)
        #expect(report.warnings.first?.contains("一般向") == true)
        #expect(report.keywordsTried == ["候选"])
    }
}
