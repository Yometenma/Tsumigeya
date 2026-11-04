// DLsite 元数据单测（M2 §9）：不依赖网络、不依赖 GUI。
// 网络部分全部走注入的假 fetch，真页面结构靠 test/fixtures/dlsite/RJ294126.html 兜住。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  buildSearchUrl,
  createDlsiteService,
  detectRjFromPath,
  extractContentsJson,
  extractMetaContent,
  extractRjCandidates,
  extractTitleAndCircle,
  extractCircleFromBreadcrumb,
  isSearchResultPage,
  normalizeCoverUrl,
  normalizeRj,
  parseDlsiteWork,
  parseSearchResults,
  scanBalancedObject
} from '../src/main/dlsite'

const fixture = readFileSync(path.join(__dirname, 'fixtures', 'dlsite', 'RJ294126.html'), 'utf8')

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tsmg-dlsite-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('normalizeRj', () => {
  test('接受各种写法并统一成大写 RJ', () => {
    expect(normalizeRj('RJ294126')).toBe('RJ294126')
    expect(normalizeRj('rj294126')).toBe('RJ294126')
    expect(normalizeRj('  RJ-294126 ')).toBe('RJ294126')
    expect(normalizeRj('RJ_294126')).toBe('RJ294126')
    expect(normalizeRj('294126')).toBe('RJ294126')
  })

  test('位数不合 / 非法字符 → null', () => {
    expect(normalizeRj('RJ1234')).toBeNull() // 太短
    expect(normalizeRj('RJ123456789')).toBeNull() // 太长
    expect(normalizeRj('RJabc123')).toBeNull()
    expect(normalizeRj('')).toBeNull()
    expect(normalizeRj(undefined)).toBeNull()
    expect(normalizeRj(294126)).toBeNull() // 数字类型不接受
  })
})

describe('extractRjCandidates', () => {
  test('从混排文本里提取，去重且保序', () => {
    expect(extractRjCandidates('RJ294126 と RJ311111 と RJ294126')).toEqual(['RJ294126', 'RJ311111'])
  })

  test('小写 / 带分隔符也能提取', () => {
    expect(extractRjCandidates('目录 rj-123456 里')).toEqual(['RJ123456'])
  })

  test('8 位数是合法的 RJ（不能被当成「太长」拒绝）', () => {
    expect(extractRjCandidates('RJ29412699')).toEqual(['RJ29412699'])
  })

  test('超过 8 位的数字串不能被截断成 RJ（尾部负向断言的作用）', () => {
    // 10 位：贪心取 8 位后「后面还有数字」→ 回退 7/6 位也都被 (?!\d) 否掉 → 不匹配
    expect(extractRjCandidates('RJ1234567890')).toEqual([])
    expect(extractRjCandidates('编号 RJ1234567890 结束')).toEqual([])
  })

  test('非字符串 / 空 → 空数组', () => {
    expect(extractRjCandidates('')).toEqual([])
    expect(extractRjCandidates(undefined)).toEqual([])
  })
})

describe('detectRjFromPath', () => {
  test('从目录名识别', () => {
    // 目录可以不存在，按字面路径猜
    expect(detectRjFromPath('/games/RJ294126 純愛おま○こ当番')).toEqual(['RJ294126'])
  })

  test('从深层路径段识别，目录名优先', () => {
    const list = detectRjFromPath('/archive/RJ111111/RJ222222/game.exe')
    expect(list[0]).toBe('RJ222222') // 目录名（game.exe 的父目录）
    expect(list).toContain('RJ111111')
  })

  test('从 readme 里识别（目标目录内 readme*.txt 头部）', () => {
    const dir = path.join(dataDir, 'game')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'readme.txt'), '作品番号 RJ333333 です', 'utf8')
    expect(detectRjFromPath(dir)).toEqual(['RJ333333'])
  })

  test('多个不同 RJ 时全部返回（让用户选，不瞎猜）', () => {
    const dir = path.join(dataDir, 'RJ444444')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'README.md'), 'RJ555555', 'utf8')
    expect(detectRjFromPath(dir)).toEqual(['RJ444444', 'RJ555555'])
  })

  test('空路径 / 没有 RJ → 空数组', () => {
    expect(detectRjFromPath('')).toEqual([])
    expect(detectRjFromPath('/games/some-plain-game')).toEqual([])
  })
})

describe('scanBalancedObject / extractContentsJson', () => {
  test('字符串里的 }; 不会提前截断（调研那个正则的坑）', () => {
    const html = '<script>var contents = {"detail":[{"name":"a }; b","x":1}],"time":0};</script>'
    const value = extractContentsJson(html) as { detail: Array<{ name: string; x: number }> }
    expect(value.detail[0]).toEqual({ name: 'a }; b', x: 1 })
  })

  test('嵌套对象正确配对', () => {
    const text = '{"a":{"b":{"c":1}}}'
    expect(scanBalancedObject(text, 0)).toBe(text.length - 1)
  })

  test('括号不平衡 → -1', () => {
    expect(scanBalancedObject('{"a":1', 0)).toBe(-1)
  })

  test('取最后一次出现的 contents（页面别处有同名变量）', () => {
    const html = 'var contents = {"detail":[{"name":"假"}]}; ... var contents = {"detail":[{"name":"真"}]};'
    const value = extractContentsJson(html) as { detail: Array<{ name: string }> }
    expect(value.detail[0].name).toBe('真')
  })

  test('没有 contents / 不是字符串 → null', () => {
    expect(extractContentsJson('<html></html>')).toBeNull()
    expect(extractContentsJson(undefined)).toBeNull()
  })

  test('JSON 语法错 → null（不抛）', () => {
    expect(extractContentsJson('var contents = {"a":1,,};')).toBeNull()
  })

  test('真 fixture 能解析出 detail[0]', () => {
    const value = extractContentsJson(fixture) as { detail: Array<Record<string, unknown>> }
    expect(value.detail[0].id).toBe('RJ294126')
  })
})

describe('og 标签与社团', () => {
  test('og:title 拆出名字与 [社团名]', () => {
    const result = extractTitleAndCircle('純愛おま○こ当番【アップデート版】 [青春×フェティシズム] | DLsite')
    expect(result.titleFull).toBe('純愛おま○こ当番【アップデート版】')
    expect(result.circle).toBe('青春×フェティシズム')
  })

  test('没有 [社团] 时只返回名字', () => {
    expect(extractTitleAndCircle('とある作品 | DLsite')).toEqual({ titleFull: 'とある作品' })
  })

  test('空 / undefined → {}', () => {
    expect(extractTitleAndCircle(undefined)).toEqual({})
    expect(extractTitleAndCircle('')).toEqual({})
  })

  test('extractMetaContent 支持两种属性顺序 + 实体解码', () => {
    expect(extractMetaContent('<meta property="og:title" content="甲 &amp; 乙">', 'og:title')).toBe('甲 & 乙')
    expect(extractMetaContent('<meta content="丙" property="og:title">', 'og:title')).toBe('丙')
    expect(extractMetaContent('<meta property="og:image" content="x">', 'og:title')).toBeUndefined()
  })

  test('面包屑回退能拿到社团名与 RG 号', () => {
    const html =
      '<a href="/maniax/circle/profile/=/maker_id/RG51931.html"><span class="text">青春×フェティシズム</span></a>'
    expect(extractCircleFromBreadcrumb(html)).toEqual({ circle: '青春×フェティシズム', circleId: 'RG51931' })
  })

  test('没有面包屑 → {}', () => {
    expect(extractCircleFromBreadcrumb('<html></html>')).toEqual({})
  })
})

describe('normalizeCoverUrl（D22 主机白名单）', () => {
  test('协议相对地址 → https 绝对地址', () => {
    expect(normalizeCoverUrl('//img.dlsite.jp/modpub/images2/work/RJ294126_img_main.jpg')).toBe(
      'https://img.dlsite.jp/modpub/images2/work/RJ294126_img_main.jpg'
    )
  })

  test('http 升级为 https', () => {
    expect(normalizeCoverUrl('http://img.dlsite.jp/a.jpg')).toBe('https://img.dlsite.jp/a.jpg')
  })

  test('非 img.dlsite.jp 主机一律丢弃（防任意远程图进渲染层）', () => {
    expect(normalizeCoverUrl('https://evil.example.com/x.jpg')).toBeUndefined()
    expect(normalizeCoverUrl('https://img.dlsite.jp.evil.com/x.jpg')).toBeUndefined()
    expect(normalizeCoverUrl('https://sub.img.dlsite.jp/x.jpg')).toBeUndefined()
  })

  test('非 http(s) / 空 / 非法 → undefined', () => {
    expect(normalizeCoverUrl('file:///etc/passwd')).toBeUndefined()
    expect(normalizeCoverUrl('javascript:alert(1)')).toBeUndefined()
    expect(normalizeCoverUrl('')).toBeUndefined()
    expect(normalizeCoverUrl(undefined)).toBeUndefined()
  })
})

describe('parseDlsiteWork（真页面 fixture）', () => {
  test('解析出调研里的全部字段', () => {
    const work = parseDlsiteWork(fixture, 'RJ294126', '2026-11-04T00:00:00.000Z')
    expect(work.rj).toBe('RJ294126')
    expect(work.title).toBe('純愛おま○こ当番【アップデート版】')
    expect(work.circle).toBe('青春×フェティシズム')
    expect(work.circleId).toBe('RG51931')
    // brand 来自 contents（RG 号），与面包屑一致
    expect(work.seriesName).toBe('おま○こ当番')
    expect(work.category).toBe('maniax')
    expect(work.workType).toBe('SOU')
    expect(work.registDate).toBe('2020/08/30')
    expect(work.price).toBe(750)
    expect(work.priceWithTax).toBe(1650)
    expect(work.coverUrl).toMatch(/^https:\/\/img\.dlsite\.jp\//)
    expect(work.fetchedAt).toBe('2026-11-04T00:00:00.000Z')
  })

  test('没有 genre / 标签字段（M2 不承诺，方案 N1）', () => {
    const work = parseDlsiteWork(fixture, 'RJ294126') as unknown as Record<string, unknown>
    expect(work).not.toHaveProperty('genre')
    expect(work).not.toHaveProperty('tags')
  })

  test('缺 detail → error.dlsiteParse', () => {
    expect(() => parseDlsiteWork('<html>nothing</html>', 'RJ294126')).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteParse' })
    )
  })

  test('RJ 号非法 → error.dlsiteInvalidRj', () => {
    expect(() => parseDlsiteWork(fixture, 'RJ123')).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteInvalidRj' })
    )
  })

  test('detail 存在但没名字 → error.dlsiteParse（不写空标题进库）', () => {
    expect(() => parseDlsiteWork('var contents = {"detail":[{"id":"RJ294126"}]};', 'RJ294126')).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteParse' })
    )
  })
})

// ===== 服务层：假 fetch =====

interface FakeCall {
  url: string
}

function makeFetcher(responses: Record<string, { status: number; body?: string } | 'throw' | 'hang'>) {
  const calls: FakeCall[] = []
  const fetchImpl = (input: string, _init?: unknown): Promise<Response> => {
    calls.push({ url: input })
    const match = Object.entries(responses).find(([key]) => input.includes(key))
    const entry = match?.[1]
    if (!entry) return Promise.resolve(new Response('', { status: 404 }))
    if (entry === 'throw') return Promise.reject(new Error('connect ECONNREFUSED'))
    if (entry === 'hang') return new Promise<Response>(() => undefined)
    return Promise.resolve(new Response(entry.body ?? '', { status: entry.status }))
  }
  return { calls, fetchImpl }
}

function service(fetcher: ReturnType<typeof makeFetcher>, options: Record<string, unknown> = {}) {
  return createDlsiteService({
    dataDir,
    fetch: fetcher.fetchImpl,
    minIntervalMs: 0,
    timeoutMs: 50,
    ...options
  })
}

describe('fetchWork 网络错误路径', () => {
  test('200 正常 → 返回 work 并写缓存', async () => {
    const fetcher = makeFetcher({ maniax: { status: 200, body: fixture } })
    const svc = service(fetcher)
    const work = await svc.fetchWork({ rj: 'RJ294126' })
    expect(work.title).toBe('純愛おま○こ当番【アップデート版】')
    expect(existsSync(svc.cachePath('RJ294126'))).toBe(true)
  })

  test('全 section 404 → error.dlsiteNotFound', async () => {
    const fetcher = makeFetcher({})
    await expect(service(fetcher).fetchWork({ rj: 'RJ999999' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteNotFound'
    })
  })

  test('maniax 404 但 homepro 有 → 回退成功', async () => {
    const fetcher = makeFetcher({ homepro: { status: 200, body: fixture } })
    const work = await service(fetcher).fetchWork({ rj: 'RJ294126' })
    expect(work.rj).toBe('RJ294126')
    expect(fetcher.calls.some((call) => call.url.includes('homepro'))).toBe(true)
  })

  test('200 但拿不到 detail（例如年龄确认页）→ error.dlsiteParse', async () => {
    const fetcher = makeFetcher({ maniax: { status: 200, body: '<html>age check</html>' } })
    await expect(service(fetcher).fetchWork({ rj: 'RJ294126' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteParse'
    })
  })

  test('连接失败 → error.dlsiteNetwork（且不重试别的 section）', async () => {
    const fetcher = makeFetcher({ 'dlsite.com': 'throw' })
    await expect(service(fetcher).fetchWork({ rj: 'RJ294126' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteNetwork'
    })
    // 网络问题是全局的，重试 section 只会让用户多等
    expect(fetcher.calls).toHaveLength(1)
  })

  test('超时 → error.dlsiteTimeout', async () => {
    const fetcher = makeFetcher({ 'dlsite.com': 'hang' })
    await expect(service(fetcher).fetchWork({ rj: 'RJ294126' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteTimeout'
    })
  })

  test('非法 RJ → error.dlsiteInvalidRj 且不发请求', async () => {
    const fetcher = makeFetcher({})
    await expect(service(fetcher).fetchWork({ rj: 'nope' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteInvalidRj'
    })
    expect(fetcher.calls).toHaveLength(0)
  })
})

describe('缓存与并发', () => {
  test('TTL 内命中缓存，不再发请求', async () => {
    const fetcher = makeFetcher({ maniax: { status: 200, body: fixture } })
    const svc = service(fetcher)
    await svc.fetchWork({ rj: 'RJ294126' })
    const before = fetcher.calls.length
    const again = await svc.fetchWork({ rj: 'RJ294126' })
    expect(again.title).toBe('純愛おま○こ当番【アップデート版】')
    expect(fetcher.calls.length).toBe(before)
  })

  test('TTL 过期会重新发请求', async () => {
    const fetcher = makeFetcher({ maniax: { status: 200, body: fixture } })
    let now = Date.parse('2026-11-04T00:00:00.000Z')
    const svc = service(fetcher, { now: () => now })
    await svc.fetchWork({ rj: 'RJ294126' })
    now += 8 * 24 * 60 * 60 * 1000 // 8 天 > 7 天 TTL
    await svc.fetchWork({ rj: 'RJ294126' })
    expect(fetcher.calls.length).toBe(2)
  })

  test('refresh:true 忽略缓存', async () => {
    const fetcher = makeFetcher({ maniax: { status: 200, body: fixture } })
    const svc = service(fetcher)
    await svc.fetchWork({ rj: 'RJ294126' })
    await svc.fetchWork({ rj: 'RJ294126', refresh: true })
    expect(fetcher.calls.length).toBe(2)
  })

  test('同 RJ 并发只发一次请求', async () => {
    const fetcher = makeFetcher({ maniax: { status: 200, body: fixture } })
    const svc = service(fetcher)
    const [a, b] = await Promise.all([svc.fetchWork({ rj: 'RJ294126' }), svc.fetchWork({ rj: 'RJ294126' })])
    expect(a.title).toBe(b.title)
    expect(fetcher.calls.length).toBe(1)
  })

  test('陈旧/损坏的缓存不影响重新抓取', async () => {
    const fetcher = makeFetcher({ maniax: { status: 200, body: fixture } })
    const svc = service(fetcher)
    mkdirSync(path.dirname(svc.cachePath('RJ294126')), { recursive: true })
    writeFileSync(svc.cachePath('RJ294126'), '{ broken', 'utf8')
    const work = await svc.fetchWork({ rj: 'RJ294126' })
    expect(work.rj).toBe('RJ294126')
    // 缓存被重写且合法
    expect(JSON.parse(readFileSync(svc.cachePath('RJ294126'), 'utf8')).rj).toBe('RJ294126')
  })
})

describe('setAdultCookie', () => {
  test('只调用一次，失败也不炸', async () => {
    let calls = 0
    const fetcher = makeFetcher({ maniax: { status: 200, body: fixture } })
    const svc = service(fetcher, {
      setAdultCookie: async () => {
        calls += 1
        throw new Error('cookie denied')
      }
    })
    await svc.fetchWork({ rj: 'RJ294126' })
    await svc.fetchWork({ rj: 'RJ111111', refresh: true })
    expect(calls).toBe(1)
  })
})

// ===== M2.5-A：按名字搜索（§A）=====

const searchFixture = readFileSync(path.join(__dirname, 'fixtures', 'dlsite', 'search-mercenary.html'), 'utf8')

describe('buildSearchUrl（§1.1 唯一有效格式）', () => {
  test('默认走 maniax + fsr/=/keyword/ 形式', () => {
    expect(buildSearchUrl('傭兵')).toBe('https://www.dlsite.com/maniax/fsr/=/keyword/%E5%82%AD%E5%85%B5')
  })

  test('换个 section 只改第一段', () => {
    expect(buildSearchUrl('傭兵', 'homepro')).toBe(
      'https://www.dlsite.com/homepro/fsr/=/keyword/%E5%82%AD%E5%85%B5'
    )
  })

  test('关键词做完整 URL 编码（日文/中文/空格/斜杠）', () => {
    expect(buildSearchUrl('傭兵の冒険')).toContain('%E5%82%AD%E5%85%B5%E3%81%AE')
    expect(buildSearchUrl('中文 关键词')).toContain('%E4%B8%AD%E6%96%87%20')
    // 编码后不能留下裸斜杠，否则会拼进 path 变了语义
    expect(buildSearchUrl('a/b')).toBe('https://www.dlsite.com/maniax/fsr/=/keyword/a%2Fb')
  })

  test('非法 category 回退到 maniax（防路径注入）', () => {
    expect(buildSearchUrl('x', '../evil')).toBe('https://www.dlsite.com/maniax/fsr/=/keyword/x')
    expect(buildSearchUrl('x', 'MANIAX')).toBe('https://www.dlsite.com/maniax/fsr/=/keyword/x')
  })
})

describe('isSearchResultPage（§1.1 判据）', () => {
  test('真 fixture 的 title 含「検索結果」', () => {
    expect(isSearchResultPage(searchFixture)).toBe(true)
  })

  test('作品页/空页/非字符串都不是结果页', () => {
    expect(isSearchResultPage(fixture)).toBe(false) // 作品详情页
    expect(isSearchResultPage('<html></html>')).toBe(false)
    expect(isSearchResultPage(undefined)).toBe(false)
  })
})

describe('parseSearchResults（真搜索页 fixture）', () => {
  test('解析出 5 个作品的 RJ 与标题', () => {
    const hits = parseSearchResults(searchFixture)
    expect(hits).toHaveLength(5)
    expect(hits.map((hit) => hit.rj)).toEqual([
      'RJ01699769',
      'RJ01348926',
      'RJ250686',
      'RJ392306',
      'RJ177899'
    ])
    expect(hits[0].title).toBe('即ハメ王女')
    expect(hits[1].title).toBe('Fallen / Brand New World')
  })

  test('噪音按钮文案（カートに追加 / お気に入りに追加 / 詳細）一条都不留', () => {
    // fixture 里真的有这些按钮（6 组），确认它们没被当成标题
    expect((searchFixture.match(/カートに追加/g) ?? []).length).toBeGreaterThan(0)
    const titles = parseSearchResults(searchFixture, 99).map((hit) => hit.title)
    expect(titles).not.toContain('カートに追加')
    expect(titles).not.toContain('お気に入りに追加')
    expect(titles).not.toContain('詳細')
  })

  test('按 RJ 去重（真页里每个 RJ 重复出现 5 次）', () => {
    const hits = parseSearchResults(searchFixture, 99)
    const rjs = hits.map((hit) => hit.rj)
    expect(new Set(rjs).size).toBe(rjs.length)
    // 宽松模式（同一页按 href 逐个扫）也必须去重
    const html = searchFixture.replace(/data-list_item_product_id="RJ[0-9]+"/g, '')
    const loose = parseSearchResults(html, 99)
    expect(new Set(loose.map((hit) => hit.rj)).size).toBe(loose.length)
  })

  test('宽松模式下也滤掉噪音（按钮的 a 也指向 product_id）', () => {
    // 只留按钮片段：结构锚点已移除，退回 href 匹配
    const buttonOnly =
      '<a href="https://www.dlsite.com/maniax/work/=/product_id/RJ123456.html">カートに追加</a>' +
      '<a href="https://www.dlsite.com/maniax/work/=/product_id/RJ123456.html">お気に入りに追加</a>'
    expect(parseSearchResults(buttonOnly, 99)).toEqual([])
  })

  test('缩略图归一化为 img.dlsite.jp 绝对地址（守 D22）', () => {
    const hits = parseSearchResults(searchFixture)
    for (const hit of hits) {
      if (hit.coverUrl) {
        expect(hit.coverUrl.startsWith('https://img.dlsite.jp/')).toBe(true)
      }
    }
    expect(hits[0].coverUrl).toContain('RJ01699769_img_main')
  })

  test('非白名单主机的缩略图被丢弃', () => {
    const html =
      '<li data-list_item_product_id="RJ123456"><div class="work_name">' +
      '<a href="https://www.dlsite.com/maniax/work/=/product_id/RJ123456.html" title="某作品">某作品</a>' +
      '</div><img src="https://evil.example.com/x.jpg"></li>'
    const hit = parseSearchResults(html)[0]
    expect(hit.title).toBe('某作品')
    expect(hit.coverUrl).toBeUndefined()
  })

  test('category 从链接 section 推断', () => {
    const hits = parseSearchResults(searchFixture)
    expect(hits[0].category).toBe('maniax')
    expect(hits[0].title).toContain('即ハメ王女')
  })

  test('limit 生效（截断到前 N 条）', () => {
    expect(parseSearchResults(searchFixture, 2)).toHaveLength(2)
    expect(parseSearchResults(searchFixture, 1)[0].rj).toBe('RJ01699769')
  })

  test('HTML 实体解码进标题', () => {
    const html =
      '<li data-list_item_product_id="RJ123456"><div class="work_name">' +
      '<a href="https://www.dlsite.com/maniax/work/=/product_id/RJ123456.html" title="A &amp; B">A &amp; B</a>' +
      '</li>'
    expect(parseSearchResults(html)[0].title).toBe('A & B')
  })

  test('空页 / 非字符串 → 空数组', () => {
    expect(parseSearchResults('')).toEqual([])
    expect(parseSearchResults(undefined)).toEqual([])
    expect(parseSearchResults('<html></html>')).toEqual([])
  })
})

describe('searchWorks（假 fetch）', () => {
  function searchService(responses: Record<string, { status: number; body?: string } | 'throw' | 'hang'>) {
    const calls: FakeCall[] = []
    const fetchImpl = (input: string, _init?: unknown): Promise<Response> => {
      calls.push({ url: input })
      const match = Object.entries(responses).find(([key]) => input.includes(key))
      const entry = match?.[1]
      if (!entry) return Promise.resolve(new Response('', { status: 404 }))
      if (entry === 'throw') return Promise.reject(new Error('connect ECONNREFUSED'))
      if (entry === 'hang') return new Promise<Response>(() => undefined)
      return Promise.resolve(new Response(entry.body ?? '', { status: entry.status }))
    }
    const svc = createDlsiteService({ dataDir, fetch: fetchImpl, minIntervalMs: 0, timeoutMs: 50 })
    return { svc, calls }
  }

  test('200 真结果页 → 返回 keyword + results', async () => {
    const { svc } = searchService({ maniax: { status: 200, body: searchFixture } })
    const result = await svc.searchWorks({ keyword: '傭兵' })
    expect(result.keyword).toBe('傭兵')
    expect(result.results).toHaveLength(5)
    expect(result.results[0].rj).toBe('RJ01699769')
  })

  test('真的请求了 fsr/=/keyword/ 且关键词被编码', async () => {
    const { svc, calls } = searchService({ maniax: { status: 200, body: searchFixture } })
    await svc.searchWorks({ keyword: '傭兵' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://www.dlsite.com/maniax/fsr/=/keyword/%E5%82%AD%E5%85%B5')
  })

  test('200 但不是结果页（条件搜索页）→ error.dlsiteSearchEmpty', async () => {
    const { svc } = searchService({ maniax: { status: 200, body: '<html><title>エラー</title></html>' } })
    await expect(svc.searchWorks({ keyword: '不存在的词' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteSearchEmpty',
      translationArguments: { keyword: '不存在的词' }
    })
  })

  test('结果页但零作品 → error.dlsiteSearchEmpty', async () => {
    const { svc } = searchService({
      maniax: { status: 200, body: '<html><title>x 検索結果</title><body>该当なし</body></html>' }
    })
    await expect(svc.searchWorks({ keyword: 'x' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteSearchEmpty'
    })
  })

  test('超时 → error.dlsiteTimeout', async () => {
    const { svc } = searchService({ maniax: 'hang' })
    await expect(svc.searchWorks({ keyword: '傭兵' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteTimeout'
    })
  })

  test('连接失败 → error.dlsiteNetwork', async () => {
    const { svc } = searchService({ maniax: 'throw' })
    await expect(svc.searchWorks({ keyword: '傭兵' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteNetwork'
    })
  })

  test('空关键词 → error.dlsiteSearchEmpty 且不发请求', async () => {
    const { svc, calls } = searchService({})
    await expect(svc.searchWorks({ keyword: '   ' })).rejects.toMatchObject({
      translationKey: 'error.dlsiteSearchEmpty'
    })
    expect(calls).toHaveLength(0)
  })

  test('limit 默认 20、上限也是 20（§7-③）', async () => {
    const many = Array.from({ length: 30 }, (_, i) => {
      const rj = `RJ${String(100000 + i)}`
      return (
        `<li data-list_item_product_id="${rj}"><div class="work_name">` +
        `<a href="https://www.dlsite.com/maniax/work/=/product_id/${rj}.html" title="作品${i}">作品${i}</a></div></li>`
      )
    }).join('')
    const body = `<html><title>検索結果</title><body>${many}</body></html>`
    const { svc } = searchService({ maniax: { status: 200, body } })
    const result = await svc.searchWorks({ keyword: '作品' })
    expect(result.results).toHaveLength(20)
    // 传更大的 limit 也会被夹到 20
    const capped = await svc.searchWorks({ keyword: '作品', limit: 100 })
    expect(capped.results).toHaveLength(20)
  })

  test('搜索不打点缓存目录（只在内存里返结果）', async () => {
    const { svc } = searchService({ maniax: { status: 200, body: searchFixture } })
    await svc.searchWorks({ keyword: '傭兵' })
    expect(existsSync(path.join(dataDir, 'dlsite'))).toBe(false)
  })
})
