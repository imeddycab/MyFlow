# MyFlow

Aplicación web progresiva para planificar rutinas de fuerza y registrar entrenamientos. Incluye un servidor Swift con Vapor y una interfaz web adaptable a móvil y escritorio.

## Funciones

- Crear rutinas y elegir ejercicios del catálogo o registrar ejercicios propios.
- Configurar series, repeticiones y descanso por ejercicio.
- Planificar sesiones por día y consultar el calendario.
- Guiar entrenamientos con cronómetro, descansos, pausa y registro de cada serie.
- Consultar historial y estadísticas, y compartir el resumen de una sesión.
- Instalar la aplicación como PWA.

## Tecnologías

- Swift 5.9 o posterior
- Vapor 4
- HTML, CSS y JavaScript
- Persistencia local en archivos JSON

## Estructura

```text
Package.swift                 Configuración del paquete Swift
Package.resolved              Versiones de dependencias
Sources/App/main.swift        Servidor Vapor y API
Public/                        Interfaz web y recursos de la PWA
Dockerfile                     Compilación y ejecución del servidor
render.yaml                    Configuración del servicio en Render
Data/                          Archivos de datos creados al ejecutar
```

## Ejecutar localmente

Desde la carpeta del proyecto, con Swift 5.9 o posterior instalado:

```sh
swift run MyFlow serve --hostname 127.0.0.1 --port 8080
```

Visita <http://127.0.0.1:8080>. El servidor crea `Data/` al iniciar y carga rutinas de ejemplo si todavía no hay datos guardados.

## Desplegar en Render

1. Conecta este repositorio de GitHub a un servicio web de Render.
2. Selecciona la rama que quieres publicar. `render.yaml` configura el servicio Docker y la verificación `/api/health`.
3. Render construye y ejecuta la aplicación desde `Dockerfile`.

La aplicación escucha en el puerto definido por Render mediante la variable `PORT`.

## Datos y limitaciones

Los perfiles, rutinas y sesiones se guardan en archivos JSON dentro de `Data/`. El servidor no tiene inicio de sesión; las personas que usan la misma instancia comparten los datos. El almacenamiento del plan gratuito de Render es temporal y los datos pueden perderse al reiniciar o volver a desplegar la aplicación.

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/api/health` | Estado del servidor |
| `GET`, `PUT` | `/api/profile` | Consultar o guardar el perfil |
| `GET`, `POST`, `PUT` | `/api/routines` | Consultar, crear o reemplazar rutinas |
| `PUT`, `DELETE` | `/api/routines/:id` | Editar o eliminar una rutina |
| `GET`, `POST` | `/api/sessions` | Consultar sesiones o iniciar una sesión |
| `PUT` | `/api/sessions/:id` | Actualizar una sesión en curso |
| `POST` | `/api/sessions/:id/finish` | Finalizar una sesión |
