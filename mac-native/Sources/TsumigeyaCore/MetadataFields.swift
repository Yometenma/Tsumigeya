import Foundation

/// AI 草稿与手工填写共用字段选择；未勾选字段不擦除同一作品已有值。
public enum MetadataFields {
    public static func text(_ work: DlsiteWork, field: String) -> String {
        switch field {
        case "title": work.title ?? ""
        case "titleSub": work.titleSub ?? ""
        case "circle": work.circle ?? ""
        case "description": work.description ?? ""
        case "coverUrl": work.coverUrl ?? ""
        case "releaseDate": work.releaseDate ?? ""
        case "series": work.series ?? ""
        case "workType": work.workType ?? ""
        case "ageRating": work.ageRating ?? ""
        case "supportedSystems": work.supportedSystems ?? ""
        case "tags": work.tags.joined(separator: "、")
        case "languages": work.languages.joined(separator: "、")
        case "creators": work.creators.joined(separator: "、")
        case "voiceActors": work.voiceActors.joined(separator: "、")
        default: ""
        }
    }
    public static func set(_ work: inout DlsiteWork, field: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let value: String? = trimmed.isEmpty ? nil : trimmed
        let list = trimmed.components(separatedBy: CharacterSet(charactersIn: "、,，")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        switch field {
        case "title": work.title = value
        case "titleSub": work.titleSub = value
        case "circle": work.circle = value
        case "description": work.description = value
        case "coverUrl": work.coverUrl = value
        case "releaseDate": work.releaseDate = value
        case "series": work.series = value
        case "workType": work.workType = value
        case "ageRating": work.ageRating = value
        case "supportedSystems": work.supportedSystems = value
        case "tags": work.tags = list
        case "languages": work.languages = list
        case "creators": work.creators = list
        case "voiceActors": work.voiceActors = list
        default: break
        }
    }
    public static func selecting(_ draft: DlsiteWork, existing: DlsiteWork?, fields: Set<String>) -> DlsiteWork {
        var work = draft
        let baseline = existing.flatMap { $0.identity == draft.identity ? $0 : nil }
        for field in EditedFields.editable where !fields.contains(field) {
            set(&work, field: field, text: baseline.map { text($0, field: field) } ?? "")
        }
        work.fieldEvidence = work.fieldEvidence.filter { key, _ in fields.contains(String(key.split(separator: ".").first ?? "")) }
        return work
    }
}
