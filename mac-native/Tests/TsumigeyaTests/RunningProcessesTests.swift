import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("进程存活判定")
struct RunningProcessesTests {

    @Test("当前进程存活")
    func selfIsAlive() {
        let processes = RunningProcesses()
        #expect(processes.isAlive(pid: getpid()))
    }

    @Test("pid 非正数当不在")
    func nonPositivePid() {
        let processes = RunningProcesses()
        #expect(!processes.isAlive(pid: 0))
        #expect(!processes.isAlive(pid: -1))
    }

    @Test("退出的子进程判成不在")
    func exitedChildIsNotAlive() throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "exit 0"]
        try p.run()

        let pid = p.processIdentifier
        #expect(pid > 0)

        p.waitUntilExit()

        let processes = RunningProcesses()
        let result = processes.isAlive(pid: pid)
        #expect(!result, "已退出的进程不该被当成运行中")
    }

    @Test("不存在的 pid")
    func nonexistentPid() {
        let processes = RunningProcesses()
        #expect(!processes.isAlive(pid: 999_999))
    }
}
