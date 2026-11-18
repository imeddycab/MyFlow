# MyFlow

Aplicación web progresiva para organizar rutinas, registrar entrenamientos y consultar el historial por cuenta de usuario.

## Funciones

- Acceso con una cuenta de Google mediante Firebase Authentication.
- Rutinas, sesiones y perfil guardados por usuario en Cloud Firestore.
- Biblioteca de ejercicios, favoritos, calendario y preferencias guardados en el navegador por cuenta.
- Temporizadores, historial, estadísticas, exportación y resumen compartible.
- Interfaz adaptable a escritorio y móvil, instalable como PWA.

## Tecnologías

- Swift 5.9 y Vapor 4 para servir la aplicación.
- HTML, CSS y JavaScript.
- Firebase Authentication y Cloud Firestore.

## Configuración de Firebase

1. En Firebase Authentication, habilita el proveedor **Google**.
2. Agrega el dominio de Render en Authentication → Settings → Authorized domains. Para desarrollo local, agrega también `localhost`.
3. En Cloud Firestore, abre la pestaña **Rules** y publica el contenido de [`firestore.rules`](firestore.rules). Las reglas limitan cada perfil, rutina y sesión a la cuenta autenticada propietaria.
4. La configuración web del proyecto Firebase está en [`Public/firebase.js`](Public/firebase.js). La clave de API web es visible en el cliente; no agregues claves de cuentas de servicio ni credenciales administrativas a `Public/`.

La primera vez que una cuenta inicia sesión, MyFlow crea rutinas iniciales en su espacio de Firestore. Los datos que antes estaban en los archivos JSON del servidor no se migran automáticamente. Las preferencias locales se separan por cuenta en cada navegador y no se sincronizan entre dispositivos.

## Ejecutar localmente

Se requiere Swift 5.9 o posterior.

```sh
swift run MyFlow serve --hostname 127.0.0.1 --port 8080
```

Abre <http://127.0.0.1:8080>. El dominio local debe estar autorizado en Firebase Authentication.

## Desplegar en Render

Conecta el repositorio de GitHub a Render. [`render.yaml`](render.yaml) configura el servicio Docker y la verificación `/api/health`; Render construye la aplicación desde [`Dockerfile`](Dockerfile).

No se requiere una clave de cuenta de servicio en Render: el navegador se autentica con Firebase y Firestore aplica las reglas por UID.

## Servidor

Vapor sirve los archivos estáticos y expone `/api/health` para la comprobación de disponibilidad. Las operaciones de perfil, rutinas y sesiones se realizan desde el navegador con el SDK de Firebase y quedan protegidas por las reglas de Firestore.
