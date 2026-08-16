// auth.js - modular Firebase v12 imports (Google provider)
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const providerGoogle = new GoogleAuthProvider();
const db = getFirestore(app);

// Start sign-in popup for Google
export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, providerGoogle);
  // result.user will be handled by onAuthChange
  return result;
}

// Sign out helper
export async function signOut() {
  return fbSignOut(auth);
}

// Observe auth state, upsert a minimal user doc, and call callback(user)
export function onAuthChange(cb) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const uRef = doc(db, 'users', user.uid);
      try {
        const snap = await getDoc(uRef);
        if (!snap.exists()) {
          await setDoc(uRef, {
            uid: user.uid,
            displayName: user.displayName || null,
            email: user.email || null,
            photoURL: user.photoURL || null,
            earnings: 0,
            coins: 0,
            createdAt: serverTimestamp()
          }, { merge: true });
        } else {
          await setDoc(uRef, { lastSeen: serverTimestamp() }, { merge: true });
        }
      } catch (err) {
        console.error('Error upserting user:', err);
      }
    }
    cb(user);
  });
}

export function getFirestoreDB() { return db; }
export function getAuthInstance() { return auth; }
