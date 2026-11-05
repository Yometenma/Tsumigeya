// 新建分类的小弹窗。
//
// ===== 为什么是一个独立的小 sheet 而不是行内输入 =====
//
// 分类名有**校验**（非空、不超长、不重名）。行内输入框在提交失败时
// 只能靠一个红字提示，而 sheet 有空间把**规则写在输入框下面**，
// 用户不用「试错」才知道限制。
//
// ⚠️ 校验判据全部来自 `Categories`（纯函数，有单测）——
//    这里只负责把错误翻成人话，**不重新实现判据**
//    （重写一份必然与那边不一致，而且没有单测守着）。
import SwiftUI
import TsumigeyaCore

struct CreateCategorySheet: View {
    @EnvironmentObject private var store: AppStore
    @State private var name = ""
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("新建分类")
                .font(.title3.weight(.semibold))

            TextField("分类名", text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { create() }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else {
                // 规则写在输入框下面（而不是等用户撞上去才知道）
                Text("最多 \(Categories.nameMax) 个字，不能与已有分类重名。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("取消") {
                    store.closeCreateCategory()
                }
                .keyboardShortcut(.cancelAction)

                Button("创建") {
                    create()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 360)
        .onAppear { focused = true }
    }

    private func create() {
        errorMessage = nil

        // ⚠️ **判据不在这里重写**：调 `Categories.create`（纯函数，有 20 条单测）。
        //    它返回 nil 时按顺序区分两种原因（空 / 超长 / 重名）——
        //    用户需要知道具体是哪一条，否则只能乱试。
        if Categories.validateName(name) != nil {
            errorMessage = Categories.validateName(name) == .empty
                ? "分类名不能为空"
                : "分类名太长了（最多 \(Categories.nameMax) 个字）"
            return
        }
        if Categories.isDuplicateName(store.categories, raw: name) {
            errorMessage = "已经有同名分类了"
            return
        }

        if store.createCategory(name: name) {
            store.closeCreateCategory()
        } else {
            errorMessage = "创建失败"
        }
    }
}
