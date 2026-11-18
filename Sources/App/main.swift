import Vapor
import Foundation

struct HealthResponse: Content {
    var status: String
    var service: String
}

@main
struct MyFlowApp {
    static func main() async throws {
        var env = try Environment.detect()
        try LoggingSystem.bootstrap(from: &env)
        let app = try await Application.make(env)
        app.http.server.configuration.hostname = "0.0.0.0"
        app.http.server.configuration.port = Environment.get("PORT").flatMap(Int.init) ?? 10000
        app.middleware.use(FileMiddleware(publicDirectory: app.directory.publicDirectory))

        app.get { req async throws -> Response in
            let indexPath = app.directory.publicDirectory + "index.html"
            guard FileManager.default.fileExists(atPath: indexPath) else {
                var response = Response(status: .serviceUnavailable)
                response.headers.contentType = .html
                response.body = .init(string: """
                <!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MyFlow · Interfaz faltante</title><body style="font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px;color:#111;background:#f5f5f5"><h1>No se encuentra la interfaz de MyFlow</h1><p>Revisa que los archivos de la carpeta <code>Public/</code> estén junto a este servidor Swift.</p></body></html>
                """)
                return response
            }
            return try await req.fileio.asyncStreamFile(at: indexPath)
        }

        app.get("api", "health") { _ in HealthResponse(status: "ok", service: "MyFlow") }

        do {
            try await app.execute()
            try await app.asyncShutdown()
        } catch {
            try await app.asyncShutdown()
            throw error
        }
    }
}
