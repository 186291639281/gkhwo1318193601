// app.js - math game logic (ES module) - EASY mode generator
// Expects auth.js in same folder to export: onAuthChange, getFirestoreDB, signOut
import { onAuthChange, getFirestoreDB, signOut } from './auth.js';
import {
  doc, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

// Game config
const EARN_PER_CORRECT = 0.10;
const STREAK_BONUS_STEP = 5;
const STREAK_BONUS_MULTIPLIER = 2;
const AUTOSAVE_DEBOUNCE = 900; // ms

// Elements
const el = {
  earnings: document.getElementById('earnings'),
  coins: document.getElementById('coins'),
  streak: document.getElementById('streak'),
  accuracy: document.getElementById('accuracy'),
  problem: document.getElementById('problem'),
  answer: document.getElementById('answer'),
  submit: document.getElementById('submit'),
  skip: document.getElementById('skip'),
  feedback: document.getElementById('feedback'),
  reset: document.getElementById('reset'),
  difficulty: document.getElementById('difficulty'),
  signout: document.getElementById('signout')
};

let db = getFirestoreDB();
let currentUser = null;
let userRef = null;
let saveTimer = null;

let state = {
  earnings: 0,
  coins: 0,
  correct: 0,
  total: 0,
  streak: 0,
  current: null,
  difficulty: 1 // default to Easy
};

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// EASY problem generator: small numbers for addition, subtraction, small multiplication, integer division
function generateProblem(difficultyLevel) {
  // For now difficultyLevel is ignored and we always produce easy problems.
  const ops = ['+', '-', '×', '÷'];
  const op = ops[randInt(0, ops.length - 1)];
  let a, b, answer;

  switch (op) {
    case '+':
      a = randInt(1, 10);
      b = randInt(1, 10);
      answer = a + b;
      break;
    case '-':
      a = randInt(0, 10);
      b = randInt(0, 10);
      if (b > a) [a, b] = [b, a]; // keep non-negative
      answer = a - b;
      break;
    case '×':
      a = randInt(1, 5);
      b = randInt(1, 5);
      answer = a * b;
      break;
    case '÷':
      b = randInt(1, 5);
      const q = randInt(1, 5);
      a = b * q; // ensures integer quotient
      answer = q;
      break;
  }

  return { a, b, op, answer };
}

function updateUI(){
  el.earnings.textContent = state.earnings.toFixed(2);
  el.coins.textContent = state.coins;
  el.streak.textContent = state.streak;
  const acc = state.total === 0 ? 0 : Math.round((state.correct/state.total)*100);
  el.accuracy.textContent = acc + '%';
  if (state.current) {
    const {a,b,op} = state.current;
    el.problem.textContent = `${a} ${op} ${b} = ?`;
  } else {
    el.problem.textContent = '—';
  }
}

function saveStateDebounced(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateToFirestore, AUTOSAVE_DEBOUNCE);
}

async function saveStateToFirestore(){
  if (!currentUser || !userRef) return;
  const payload = {
    gameState: {
      earnings: state.earnings,
      coins: state.coins,
      correct: state.correct,
      total: state.total,
      streak: state.streak,
      difficulty: state.difficulty,
      current: state.current
    },
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(userRef, payload, { merge: true });
    showFeedback('Progress saved', 'success', 800);
  } catch (err) {
    console.error('Save failed', err);
    showFeedback('Save failed — offline?', 'error', 1200);
  }
}

function loadDefaultsFromServer(docData){
  if (!docData || !docData.gameState) return;
  const g = docData.gameState;
  state.earnings = g.earnings || 0;
  state.coins = g.coins || 0;
  state.correct = g.correct || 0;
  state.total = g.total || 0;
  state.streak = g.streak || 0;
  state.difficulty = g.difficulty || 1;
  state.current = g.current || null;
}

function nextProblem(){
  state.current = generateProblem(state.difficulty || 1);
  el.answer.value = '';
  el.feedback.textContent = '';
  updateUI();
  saveStateDebounced();
  el.answer.focus();
}

function showFeedback(msg, cls, timeout=900){
  el.feedback.textContent = msg;
  el.feedback.className = 'feedback ' + (cls==='success' ? 'success' : cls==='error' ? 'error' : '');
  if (timeout) setTimeout(()=>{ el.feedback.textContent = ''; el.feedback.className = 'feedback'; }, timeout);
}

function applyCorrect(){
  state.correct++; state.total++; state.streak++;
  let earn = EARN_PER_CORRECT; let coinGain = 1;
  if (state.streak > 0 && state.streak % STREAK_BONUS_STEP === 0){
    earn *= STREAK_BONUS_MULTIPLIER;
    coinGain *= STREAK_BONUS_MULTIPLIER;
  }
  state.earnings = +(state.earnings + earn).toFixed(2);
  state.coins += coinGain;
  showFeedback(`Correct! +$${earn.toFixed(2)}, +${coinGain} coin${coinGain>1?'s':''}`,'success',900);
}

function applyIncorrect(correctAnswer){
  state.total++; state.streak = 0;
  showFeedback(`Wrong — correct: ${correctAnswer}`,'error',900);
}

function submitAnswer(){
  const raw = el.answer.value.trim();
  if (raw === '') { showFeedback('Enter an answer or click Skip','error',900); return; }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) { showFeedback('Please enter a valid number','error',900); return; }
  const correct = state.current.answer;
  if (Math.abs(numeric - correct) < 1e-9) applyCorrect(); else applyIncorrect(correct);
  updateUI();
  saveStateDebounced();
  setTimeout(nextProblem, 800);
}

// Event wiring
el.submit.addEventListener('click', submitAnswer);
el.answer.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') submitAnswer(); });
el.skip.addEventListener('click', ()=>{ state.total++; state.streak=0; showFeedback(`Skipped — correct was ${state.current.answer}`,'',700); saveStateDebounced(); setTimeout(nextProblem,700); });
el.reset.addEventListener('click', async ()=> {
  if (!confirm('Reset earnings, coins, and progress?')) return;
  state = { earnings:0, coins:0, correct:0, total:0, streak:0, current:null, difficulty: state.difficulty || 1 };
  updateUI();
  await saveStateToFirestore();
  nextProblem();
});
el.difficulty.addEventListener('change', (e)=> { state.difficulty = Number(e.target.value); saveStateDebounced(); nextProblem(); });
el.signout.addEventListener('click', async ()=> { await signOut(); window.location.href = 'index.html'; });

// Auth gating and initial load
onAuthChange(async (user) => {
  if (!user) {
    // not signed in -> redirect to login
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;
  userRef = doc(db, 'users', user.uid);
  // load existing user doc
  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      loadDefaultsFromServer(snap.data());
    } else {
      // create initial user doc with gameState
      await setDoc(userRef, { gameState: state, createdAt: serverTimestamp() }, { merge: true });
    }
  } catch (err) {
    console.error('Error reading user doc', err);
  }
  // if no current problem, generate one
  if (!state.current) nextProblem(); else updateUI();
});
