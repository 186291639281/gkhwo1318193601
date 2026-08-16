// app.js - math game logic (ES module)
// Improved: load/save race fixed so earnings persist per account across refreshes
// Expects auth.js in same folder to export: onAuthChange, getFirestoreDB, signOut
import { onAuthChange, getFirestoreDB, signOut } from './auth.js';
import {
  doc, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

// Earnings configuration per difficulty (1=Easy, 2=Medium, 3=Hard)
const EARN_BY_DIFFICULTY = {
  1: 0.05, // Easy
  2: 0.10, // Medium
  3: 0.25  // Hard
};
const COINS_BY_DIFFICULTY = {
  1: 1,
  2: 2,
  3: 5
};
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
let loadedFromServer = false; // prevents saving defaults before load

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

// Easy generator (small numbers)
function generateEasyProblem() {
  const ops = ['+', '-', '×', '÷'];
  const op = ops[randInt(0, ops.length - 1)];
  let a, b, answer;
  switch (op) {
    case '+': a = randInt(1,10); b = randInt(1,10); answer = a + b; break;
    case '-': a = randInt(0,10); b = randInt(0,10); if (b>a) [a,b]=[b,a]; answer = a - b; break;
    case '×': a = randInt(1,5); b = randInt(1,5); answer = a * b; break;
    case '÷': b = randInt(1,5); const q = randInt(1,5); a = b * q; answer = q; break;
  }
  return {a,b,op,answer};
}

// Medium generator (larger numbers)
function generateMediumProblem() {
  const ops = ['+', '-', '×', '÷'];
  const op = ops[randInt(0, ops.length - 1)];
  let a, b, answer;
  switch (op) {
    case '+': a = randInt(10,50); b = randInt(5,50); answer = a + b; break;
    case '-': a = randInt(0,60); b = randInt(0,40); if (b>a) [a,b]=[b,a]; answer = a - b; break;
    case '×': a = randInt(2,12); b = randInt(2,12); answer = a * b; break;
    case '÷': b = randInt(2,12); const q = randInt(2,12); a = b * q; answer = q; break;
  }
  return {a,b,op,answer};
}

// Hard generator (larger numbers and wider ranges)
function generateHardProblem() {
  const ops = ['+', '-', '×', '÷'];
  const op = ops[randInt(0, ops.length - 1)];
  let a, b, answer;
  switch (op) {
    case '+': a = randInt(50,200); b = randInt(20,200); answer = a + b; break;
    case '-': a = randInt(0,250); b = randInt(0,200); if (b>a) [a,b]=[b,a]; answer = a - b; break;
    case '×': a = randInt(5,20); b = randInt(5,20); answer = a * b; break;
    case '÷': b = randInt(3,20); const q = randInt(2,20); a = b * q; answer = q; break;
  }
  return {a,b,op,answer};
}

function generateProblem(difficultyLevel) {
  if (difficultyLevel === 1) return generateEasyProblem();
  if (difficultyLevel === 2) return generateMediumProblem();
  return generateHardProblem();
}

// Validate a problem object loaded from server or memory
function isValidProblem(p) {
  return p && typeof p.a === 'number' && typeof p.b === 'number' && (typeof p.answer !== 'undefined') && typeof p.op === 'string';
}

function updateUI(){
  el.earnings.textContent = state.earnings.toFixed(2);
  el.coins.textContent = state.coins;
  el.streak.textContent = state.streak;
  const acc = state.total === 0 ? 0 : Math.round((state.correct/state.total)*100);
  el.accuracy.textContent = acc + '%';
  if (!isValidProblem(state.current)) {
    // If invalid, generate a new one and return (nextProblem updates UI and saves)
    console.info('State.current invalid or missing — generating a new problem');
    nextProblem();
    return;
  }
  const {a,b,op} = state.current;
  el.problem.textContent = `${a} ${op} ${b} = ?`;
}

function saveStateDebounced(){
  // don't autosave until we've loaded state from server to avoid overwriting with defaults on refresh
  if (!loadedFromServer) return;
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
    // merge:true to avoid clobbering unrelated fields
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
  state.earnings = typeof g.earnings === 'number' ? g.earnings : 0;
  state.coins = typeof g.coins === 'number' ? g.coins : 0;
  state.correct = typeof g.correct === 'number' ? g.correct : 0;
  state.total = typeof g.total === 'number' ? g.total : 0;
  state.streak = typeof g.streak === 'number' ? g.streak : 0;
  state.difficulty = typeof g.difficulty === 'number' ? g.difficulty : 1;
  state.current = g.current || null;
}

function nextProblem(){
  state.current = generateProblem(state.difficulty || 1);
  if (el.answer) el.answer.value = '';
  if (el.feedback) el.feedback.textContent = '';
  updateUI();
  saveStateDebounced();
  if (el.answer) el.answer.focus();
}

function showFeedback(msg, cls, timeout=900){
  if (!el.feedback) return;
  el.feedback.textContent = msg;
  el.feedback.className = 'feedback ' + (cls==='success' ? 'success' : cls==='error' ? 'error' : '');
  if (timeout) setTimeout(()=>{ el.feedback.textContent = ''; el.feedback.className = 'feedback'; }, timeout);
}

function applyCorrect(){
  state.correct++; state.total++; state.streak++;
  const baseEarn = EARN_BY_DIFFICULTY[state.difficulty] || 0.1;
  const baseCoins = COINS_BY_DIFFICULTY[state.difficulty] || 1;
  let earn = baseEarn;
  let coinGain = baseCoins;
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
  const raw = (el.answer && el.answer.value) ? el.answer.value.trim() : '';
  if (raw === '') { showFeedback('Enter an answer or click Skip','error',900); return; }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) { showFeedback('Please enter a valid number','error',900); return; }
  const correct = state.current && state.current.answer;
  if (typeof correct === 'undefined') { showFeedback('No active problem — generating one','error',900); nextProblem(); return; }
  if (Math.abs(numeric - correct) < 1e-9) applyCorrect(); else applyIncorrect(correct);
  updateUI();
  saveStateDebounced();
  setTimeout(nextProblem, 800);
}

// Event wiring
if (el.submit) el.submit.addEventListener('click', submitAnswer);
if (el.answer) el.answer.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') submitAnswer(); });
if (el.skip) el.skip.addEventListener('click', ()=>{ state.total++; state.streak=0; showFeedback(`Skipped — correct was ${state.current?state.current.answer:'unknown'}`,'',700); saveStateDebounced(); setTimeout(nextProblem,700); });
if (el.reset) {
  el.reset.addEventListener('click', async ()=> {
    if (!confirm('Reset earnings, coins, and progress?')) return;
    state = { earnings:0, coins:0, correct:0, total:0, streak:0, current:null, difficulty: state.difficulty || 1 };
    updateUI();
    // persist reset immediately
    if (loadedFromServer) await saveStateToFirestore();
    nextProblem();
  });
}
if (el.difficulty) el.difficulty.addEventListener('change', (e)=> { state.difficulty = Number(e.target.value); saveStateDebounced(); nextProblem(); });
if (el.signout) el.signout.addEventListener('click', async ()=> { await signOut(); window.location.href = 'index.html'; });

// Auth gating and initial load
onAuthChange(async (user) => {
  if (!user) {
    // not signed in -> redirect to login
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;
  userRef = doc(db, 'users', user.uid);

  try {
    const snap = await getDoc(userRef);
    const data = snap.exists() ? snap.data() : null;

    if (data && data.gameState) {
      // load server state and enable autosave only after load
      loadDefaultsFromServer(data);
      loadedFromServer = true;
    } else {
      // initialize gameState but don't clobber existing unrelated fields
      await setDoc(userRef, { gameState: state, createdAt: serverTimestamp() }, { merge: true });
      // we have persisted initial state; mark loaded so autosave can run
      loadedFromServer = true;
    }
  } catch (err) {
    console.error('Error reading or initializing user doc', err);
    // if error, still allow play but don't autosave to avoid overwriting
    loadedFromServer = false;
  }

  // Ensure difficulty select reflects loaded state
  if (el.difficulty) el.difficulty.value = String(state.difficulty || 1);

  // if no valid current problem, generate one
  if (!isValidProblem(state.current)) {
    console.info('No valid current problem after load — generating new one');
    nextProblem();
  } else {
    updateUI();
  }
});
