import Vapor
import Foundation

struct RoutineExercise: Content {
    var name: String
    var muscle: String
    var equipment: String
    var sets: Int
    var reps: String
    var restSeconds: Int
}
struct Routine: Content, Identifiable {
    var id: UUID
    var name: String
    var description: String
    var color: String
    var exercises: [RoutineExercise]
    var dayOfWeek: String?
    var updatedAt: Date
    init(id: UUID = UUID(), name: String, description: String, color: String = "violet", exercises: [RoutineExercise] = [], dayOfWeek: String? = nil, updatedAt: Date = .now) {
        self.id = id; self.name = name; self.description = description; self.color = color; self.exercises = exercises; self.dayOfWeek = dayOfWeek; self.updatedAt = updatedAt
    }
    enum CodingKeys: String, CodingKey { case id, name, description, color, exercises, dayOfWeek, updatedAt }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        description = try values.decode(String.self, forKey: .description)
        color = try values.decodeIfPresent(String.self, forKey: .color) ?? "violet"
        exercises = try values.decodeIfPresent([RoutineExercise].self, forKey: .exercises) ?? []
        dayOfWeek = try values.decodeIfPresent(String.self, forKey: .dayOfWeek)
        updatedAt = try values.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .now
    }
}
struct RoutineInput: Content { var id: UUID?; var name: String; var description: String; var color: String?; var exercises: [RoutineExercise]?; var dayOfWeek: String? }
struct WorkoutSet: Content { var exercise: String; var weight: Double; var reps: Int; var completed: Bool }
struct WorkoutSession: Content, Identifiable {
    var id: UUID
    var routineName: String
    var startedAt: Date
    var updatedAt: Date
    var finishedAt: Date?
    var sets: [WorkoutSet]
    var durationSeconds: Int?
    init(id: UUID = UUID(), routineName: String, startedAt: Date = .now, updatedAt: Date = .now, finishedAt: Date? = nil, sets: [WorkoutSet] = [], durationSeconds: Int? = nil) {
        self.id = id; self.routineName = routineName; self.startedAt = startedAt; self.updatedAt = updatedAt; self.finishedAt = finishedAt; self.sets = sets; self.durationSeconds = durationSeconds
    }
}
struct SessionInput: Content { var routineName: String; var sets: [WorkoutSet]; var durationSeconds: Int? }
struct UserProfile: Content {
    var name: String
    var updatedAt: Date
    init(name: String, updatedAt: Date = .now) { self.name = name; self.updatedAt = updatedAt }
}
struct ProfileInput: Content { var name: String }
struct ProfileResponse: Content { var profile: UserProfile? }
struct HealthResponse: Content { var status: String; var service: String }

actor MyFlowStore {
    private let directory: URL
    private var routines: [Routine]
    private var sessions: [WorkoutSession]
    private var userProfile: UserProfile?
    init(directory: String) {
        self.directory = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
        routines = Self.load([Routine].self, from: self.directory.appendingPathComponent("routines.json")) ?? [
            Routine(name: "Push Day", description: "Pecho · Hombros · Tríceps", color: "coral"),
            Routine(name: "Pull Strength", description: "Espalda · Bíceps", color: "violet"),
            Routine(name: "Leg Power", description: "Cuádriceps · Glúteos", color: "cyan"),
            Routine(name: "Upper Hypertrophy", description: "Torso completo", color: "green")
        ]
        sessions = Self.load([WorkoutSession].self, from: self.directory.appendingPathComponent("sessions.json")) ?? []
        userProfile = Self.load(UserProfile.self, from: self.directory.appendingPathComponent("profile.json"))
    }
    func getProfile() -> UserProfile? { userProfile }
    func saveProfile(_ input: ProfileInput) throws -> UserProfile {
        let name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw Abort(.badRequest, reason: "Escribe tu nombre para continuar.") }
        let profile = UserProfile(name: name)
        try persist(profile, as: "profile.json")
        userProfile = profile
        return profile
    }
    func allRoutines() -> [Routine] { routines }
    func replaceRoutines(_ inputs: [RoutineInput]) throws -> [Routine] {
        guard inputs.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw Abort(.badRequest, reason: "Cada rutina necesita un nombre.")
        }
        let existingRoutines = routines
        let updated = inputs.enumerated().map { index, input in
            let previous = input.id.flatMap { id in existingRoutines.first(where: { $0.id == id }) }
                ?? (index < existingRoutines.count ? existingRoutines[index] : nil)
            let dayOfWeek = input.dayOfWeek.map { $0.isEmpty ? nil : $0 } ?? previous?.dayOfWeek
            return Routine(id: previous?.id ?? UUID(), name: input.name.trimmingCharacters(in: .whitespacesAndNewlines), description: input.description, color: input.color ?? previous?.color ?? "violet", exercises: input.exercises ?? previous?.exercises ?? [], dayOfWeek: dayOfWeek)
        }
        try persist(updated, as: "routines.json")
        routines = updated
        return routines
    }
    func createRoutine(_ input: RoutineInput) throws -> Routine {
        let name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw Abort(.badRequest, reason: "Escribe un nombre para la rutina.") }
        let routine = Routine(name: name, description: input.description, color: input.color ?? "violet", exercises: input.exercises ?? [], dayOfWeek: input.dayOfWeek)
        var updated = routines
        updated.append(routine)
        try persist(updated, as: "routines.json")
        routines = updated
        return routine
    }
    func updateRoutine(id: UUID, input: RoutineInput) throws -> Routine {
        guard let index = routines.firstIndex(where: { $0.id == id }) else { throw Abort(.notFound) }
        let name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw Abort(.badRequest, reason: "Escribe un nombre para la rutina.") }
        var updated = routines
        updated[index].name = name; updated[index].description = input.description
        updated[index].color = input.color ?? updated[index].color; updated[index].updatedAt = .now
        updated[index].exercises = input.exercises ?? updated[index].exercises
        if let dayOfWeek = input.dayOfWeek { updated[index].dayOfWeek = dayOfWeek.isEmpty ? nil : dayOfWeek }
        try persist(updated, as: "routines.json")
        routines = updated
        return routines[index]
    }
    func deleteRoutine(id: UUID) throws {
        guard routines.contains(where: { $0.id == id }) else { throw Abort(.notFound) }
        let updated = routines.filter { $0.id != id }
        try persist(updated, as: "routines.json")
        routines = updated
    }
    func allSessions() -> [WorkoutSession] { sessions.sorted { $0.startedAt > $1.startedAt } }
    func startSession(routineName: String, sets: [WorkoutSet], durationSeconds: Int?) throws -> WorkoutSession {
        let session = WorkoutSession(routineName: routineName, sets: sets, durationSeconds: durationSeconds)
        var updated = sessions
        updated.append(session)
        try persist(updated, as: "sessions.json")
        sessions = updated
        return session
    }
    func updateSession(id: UUID, input: SessionInput) throws -> WorkoutSession {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { throw Abort(.notFound) }
        var updated = sessions
        updated[index].routineName = input.routineName; updated[index].sets = input.sets; updated[index].durationSeconds = input.durationSeconds ?? updated[index].durationSeconds; updated[index].updatedAt = .now
        try persist(updated, as: "sessions.json")
        sessions = updated
        return sessions[index]
    }
    func finishSession(id: UUID) throws -> WorkoutSession {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { throw Abort(.notFound) }
        var updated = sessions
        updated[index].finishedAt = .now; updated[index].updatedAt = .now
        try persist(updated, as: "sessions.json")
        sessions = updated
        return sessions[index]
    }
    private func persist<T: Encodable>(_ value: T, as filename: String) throws {
        do { try JSONEncoder.myFlow.encode(value).write(to: directory.appendingPathComponent(filename), options: .atomic) }
        catch {
            print("Unable to save \(filename): \(error)")
            throw Abort(.internalServerError, reason: "No se pudieron guardar los cambios. Revisa el espacio y los permisos de almacenamiento e inténtalo de nuevo.")
        }
    }
    private static func load<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder.myFlow.decode(type, from: data)
    }
}
extension JSONEncoder {
    static var myFlow: JSONEncoder { let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; return encoder }
}
extension JSONDecoder { static var myFlow: JSONDecoder { let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601; return decoder } }

@main
struct MyFlowApp {
    static func main() async throws {
        var env = try Environment.detect()
        try LoggingSystem.bootstrap(from: &env)
        let app = try await Application.make(env)
        let store = MyFlowStore(directory: app.directory.workingDirectory + "Data")
        app.http.server.configuration.hostname = "0.0.0.0"
        app.http.server.configuration.port = Environment.get("PORT").flatMap(Int.init) ?? 10000
        app.middleware.use(FileMiddleware(publicDirectory: app.directory.publicDirectory))
        app.get { req async throws -> Response in
            let indexPath = app.directory.publicDirectory + "index.html"
            guard FileManager.default.fileExists(atPath: indexPath) else {
                var response = Response(status: .serviceUnavailable)
                response.headers.contentType = .html
                response.body = .init(string: """
                <!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MyFlow · Interfaz faltante</title><body style="font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px;color:#183226;background:#f3f2e9"><h1>No se encuentra la interfaz de MyFlow</h1><p>Revisa que los archivos <code>index.html</code>, <code>app.css</code> y <code>app.js</code> estén dentro de la carpeta <code>Public/</code>, junto a este servidor Swift.</p></body></html>
                """)
                return response
            }
            return try await req.fileio.asyncStreamFile(at: indexPath)
        }
        app.get("api", "health") { _ in HealthResponse(status: "ok", service: "MyFlow") }
        app.get("api", "profile") { _ async -> ProfileResponse in ProfileResponse(profile: await store.getProfile()) }
        app.put("api", "profile") { req async throws -> UserProfile in
            try await store.saveProfile(req.content.decode(ProfileInput.self))
        }
        app.get("api", "routines") { _ async -> [Routine] in await store.allRoutines() }
        app.put("api", "routines") { req async throws -> [Routine] in
            try await store.replaceRoutines(req.content.decode([RoutineInput].self))
        }
        app.post("api", "routines") { req async throws -> Routine in try await store.createRoutine(req.content.decode(RoutineInput.self)) }
        app.put("api", "routines", ":id") { req async throws -> Routine in
            guard let id = req.parameters.get("id", as: UUID.self) else { throw Abort(.badRequest) }
            return try await store.updateRoutine(id: id, input: req.content.decode(RoutineInput.self))
        }
        app.delete("api", "routines", ":id") { req async throws -> HTTPStatus in
            guard let id = req.parameters.get("id", as: UUID.self) else { throw Abort(.badRequest) }
            try await store.deleteRoutine(id: id); return .noContent
        }
        app.get("api", "sessions") { _ async -> [WorkoutSession] in await store.allSessions() }
        app.post("api", "sessions") { req async throws -> WorkoutSession in
            let input = try req.content.decode(SessionInput.self)
            return try await store.startSession(routineName: input.routineName, sets: input.sets, durationSeconds: input.durationSeconds)
        }
        app.put("api", "sessions", ":id") { req async throws -> WorkoutSession in
            guard let id = req.parameters.get("id", as: UUID.self) else { throw Abort(.badRequest) }
            return try await store.updateSession(id: id, input: req.content.decode(SessionInput.self))
        }
        app.post("api", "sessions", ":id", "finish") { req async throws -> WorkoutSession in
            guard let id = req.parameters.get("id", as: UUID.self) else { throw Abort(.badRequest) }
            return try await store.finishSession(id: id)
        }
        do { try await app.execute(); try await app.asyncShutdown() }
        catch { try await app.asyncShutdown(); throw error }
    }
}
