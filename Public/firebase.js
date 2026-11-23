import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js"
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js"
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js"

// La configuración web de Firebase es pública. La seguridad de los datos se
// aplica con las reglas de Firestore incluidas en firestore.rules.
const firebaseConfig = {
  apiKey: "AIzaSyDYilG6m893pvWlq_37Ablxj55aVx8Q1RQ",
  authDomain: "myflow-2ce70.firebaseapp.com",
  projectId: "myflow-2ce70",
  storageBucket: "myflow-2ce70.firebasestorage.app",
  messagingSenderId: "1026583792968",
  appId: "1:1026583792968:web:7306f59a7785c3230f377d"
}

const firebaseApp = initializeApp(firebaseConfig)
export const auth = getAuth(firebaseApp)
export const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: "select_account" })
export let firestorePersistent = false
let firestore
try {
  firestore = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  })
  firestorePersistent = true
} catch (error) {
  // Private browsing or browser storage restrictions can prevent IndexedDB persistence.
  console.warn("MyFlow will use an in-memory Firestore cache.", error)
  firestore = getFirestore(firebaseApp)
}
export { firestore }
