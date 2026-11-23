// NW.js 多版本安装的回归。
//
// 守的是「装第二个运行时」这条链路的两个易错点：
//   ① 版本号 → 依赖名必须落成 `version/<v>`（D66 的判据，少了前缀会被当普通依赖覆盖）
//   ② 下载地址必须按真实发布包拼，且**只给实测存在的架构**（编一个 arm64 地址就是 404）
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("NW.js 多版本安装")
struct NwjsRuntimeChoiceTests {

    @Test("已知版本能生成依赖，依赖名带 version/ 前缀")
    func dependencyNameIsMultiVersion() throws {
        let dep = try #require(EngineDependencies.nwjsDependency(forVersion: "v0.90.0"))
        #expect(dep.name == "version/v0.90.0")
        // D66 靠这个前缀判断「多版本依赖」→ 更新时保留已装版本
        #expect(DependencyPath.isMultiVersion(dep.name))
    }

    @Test("未知版本不给地址（不猜 URL）")
    func unknownVersionHasNoDependency() {
        #expect(EngineDependencies.nwjsDependency(forVersion: "v9.9.9") == nil)
        #expect(EngineDependencies.nwjsDependency(forVersion: "0.90.0") == nil)
    }

    @Test("arm64 + x64 双包的版本：两种架构各取自己的包")
    func splitBuildsByArch() throws {
        let dep = try #require(EngineDependencies.nwjsDependency(forVersion: "v0.90.0"))
        let arm = try #require(Engineer.pick(dep, arch: "arm64"))
        let x64 = try #require(Engineer.pick(dep, arch: "x64"))
        #expect(arm.contains("osx-arm64.zip"))
        #expect(x64.contains("osx-x64.zip"))
        #expect(arm.contains("v0.90.0"))
    }

    @Test("候选表里的版本都有 arm64 原生包")
    func allChoicesAreArm64Native() {
        for choice in EngineDependencies.nwjsRuntimeChoices {
            #expect(choice.hasArm64, "\(choice.version) 应当有 arm64 原生包")
            #expect(!choice.needsRosetta(arch: "arm64"))
        }
    }

    /// 候选表顺序 = 界面顺序，新的在前（用户先看到最新版）。
    @Test("候选表按版本号降序")
    func choicesAreSortedNewestFirst() {
        let versions = EngineDependencies.nwjsRuntimeChoices.map(\.version)
        let sorted = versions.sorted { compareVersions($0, $1) > 0 }
        #expect(versions == sorted)
    }

    /// 只有已实测出窗口的版本才标 verified，避免把「能下载」当成「能用」。
    @Test("当前默认版本是已验证的")
    func defaultVersionVerified() {
        let defaultChoice = EngineDependencies.nwjsRuntimeChoices
            .first { $0.version == "v0.106.1" }
        #expect(defaultChoice?.verified == true)
    }

    /// 小工具：直接复用安装器挑包逻辑，避免测试自己复制一份 candidates 规则。
    private enum Engineer {
        static func pick(_ dep: (name: String, spec: DependencySpec), arch: String) -> String? {
            EngineInstaller.pickBuild(spec: dep.spec, arch: arch)?.link
        }
    }
}
