// app.js - math game logic (ES module)
// Now uses atomic Firestore transactions for awarding earnings to prevent loss on refresh.
// Expects auth.js in same folder to export: onAuthChange, getFirestoreDB, signOut
import { onAuthChange, getFirestoreDB, signOut } from './auth.js';
import {
  doc, getDoc, setDoc, serverTimestamp, runTransaction, collection
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
  current: null, // still kept client-side but NOT persisted to Firestore anymore
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

// Validate a problem object
function isValidProblem(p) {
  return p && typeof p.a === 'number' && typeof p.b === 'number' && (typeof p.answer !== 'undefined') && typeof p.op === 'string';
}

function updateUI(){
  if (el.earnings) el.earnings.textContent = state.earnings.toFixed(2);
  if (el.coins) el.coins.textContent = state.coins;
  if (el.streak) el.streak.textContent = state.streak;
  const acc = state.total === 0 ? 0 : Math.round((state.correct/state.total)*100);
  if (el.accuracy) el.accuracy.textContent = acc + '%';

  if (!isValidProblem(state.current)) {
    // If invalid, generate a new one and return (nextProblem updates UI and saves)
    console.info('State.current invalid or missing — generating a new problem');
    nextProblem();
    return;
  }
  if (el.problem) {
    const {a,b,op} = state.current;
    el.problem.textContent = `${a} ${op} ${b} = ?`;
  }
}

function saveStateDebounced(){
  // don't autosave until we've loaded state from server to avoid overwriting with defaults on refresh
  if (!loadedFromServer) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateToFirestore, AUTOSAVE_DEBOUNCE);
}

// Persist only aggregated state (do NOT persist state.current)
async function saveStateToFirestore(){
  if (!currentUser || !userRef) return;
  const payload = {
    gameState: {
      earnings: state.earnings,
      coins: state.coins,
      correct: state.correct,
      total: state.total,
      streak: state.streak,
      difficulty: state.difficulty
    },
    updatedAt: serverTimestamp()
  };
  try {
    console.info('Saving gameState to server', payload.gameState);
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
  // Do NOT load persisted 'current' into client state - treat current as ephemeral client-only
  state.current = null;
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

// Award earnings atomically using a Firestore transaction and log an event
async function awardEarningsAtomic(amount, coins, reason = 'correct_answer'){
  if (!currentUser || !userRef) throw new Error('Not signed in');
  console.info('Awarding (atomic)', { amount, coins, reason });
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(userRef);
    const gs = (snap.exists() && snap.data().gameState) ? snap.data().gameState : {};
    const currentE = typeof gs.earnings === 'number' ? gs.earnings : 0;
    const currentCoins = typeof gs.coins === 'number' ? gs.coins : 0;
    const currentCorrect = typeof gs.correct === 'number' ? gs.correct : 0;
    const currentTotal = typeof gs.total === 'number' ? gs.total : 0;
    const currentStreak = typeof gs.streak === 'number' ? gs.streak : 0;

    const newCorrect = currentCorrect + 1;
    const newTotal = currentTotal + 1;
    const newStreak = currentStreak + 1;
    const newEarnings = +(currentE + amount).toFixed(2);
    const newCoins = currentCoins + coins;

    // update user's aggregated gameState (do not include current problem)
    tx.set(userRef, {
      gameState: {
        earnings: newEarnings,
        coins: newCoins,
        correct: newCorrect,
        total: newTotal,
        streak: newStreak,
        difficulty: gs.difficulty || state.difficulty
      }
    }, { merge: true });

    // log an earnings event for audit
    const eventRef = doc(collection(db, 'earningsEvents'));
    tx.set(eventRef, {
      uid: currentUser.uid,
      amount,
      coins,
      reason,
      createdAt: serverTimestamp()
    });

    return { earnings: newEarnings, coins: newCoins, correct: newCorrect, total: newTotal, streak: newStreak };
  });

  console.info('Award transaction completed', result);
  return result;
}

// updated applyCorrect returns the promise so callers can await it
function applyCorrect(){
  // compute base amounts locally, then perform atomic award
  const baseEarn = EARN_BY_DIFFICULTY[state.difficulty] || 0.1;
  const baseCoins = COINS_BY_DIFFICULTY[state.difficulty] || 1;
  let earn = baseEarn;
  let coinGain = baseCoins;
  const nextStreak = state.streak + 1;
  if (nextStreak > 0 && nextStreak % STREAK_BONUS_STEP === 0){
    earn *= STREAK_BONUS_MULTIPLIER;
    coinGain *= STREAK_BONUS_MULTIPLIER;
  }

  // return the promise so caller can await
  return awardEarningsAtomic(earn, coinGain, 'correct_answer')
    .then((res) => {
      // update local state to match server authoritative values
      state.earnings = res.earnings;
      state.coins = res.coins;
      state.correct = res.correct;
      state.total = res.total;
      state.streak = res.streak;
      showFeedback(`Correct! +$${earn.toFixed(2)}, +${coinGain} coin${coinGain>1?'s':''}`, 'success', 900);
      updateUI();
      return res;
    })
    .catch((err) => {
      console.error('Award transaction failed', err);
      showFeedback('Award failed — offline?', 'error', 1200);
      // fall back to local update so player can continue; this will be overwritten when connection restores
      state.correct++; state.total++; state.streak++;
      state.earnings = +(state.earnings + earn).toFixed(2);
      state.coins += coinGain;
      updateUI();
      saveStateDebounced();
      // rethrow so callers know it failed if they need to
      throw err;
    });
}

function applyIncorrect(correctAnswer){
  state.total++;
  state.streak = 0;
  showFeedback(`Wrong — correct: ${correctAnswer}`,'error',900);
  // persist aggregated counters
  saveStateDebounced();
}

// make submitAnswer async and await applyCorrect so the award transaction can complete
async function submitAnswer(){
  const raw = (el.answer && el.answer.value) ? el.answer.value.trim() : '';
  if (raw === '') { showFeedback('Enter an answer or click Skip','error',900); return; }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) { showFeedback('Please enter a valid number','error',900); return; }
  const correct = state.current && state.current.answer;
  if (typeof correct === 'undefined') { showFeedback('No active problem — generating one','error',900); nextProblem(); return; }
  if (Math.abs(numeric - correct) < 1e-9) {
    try {
      await applyCorrect();
    } catch (e) {
      // award failed but applyCorrect already handled fallback UI and local state
      console.warn('applyCorrect completed with error', e);
    }
  } else {
    applyIncorrect(correct);
  }
  // advance to next problem after a short delay so the user sees the feedback
  setTimeout(nextProblem, 800);
}

// Event wiring
if (el.submit) el.submit.addEventListener('click', submitAnswer);
if (el.answer) el.answer.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') submitAnswer(); });
if (el.skip) el.skip.addEventListener('click', ()=>{
  state.total++;
  state.streak = 0;
  showFeedback(`Skipped — correct was ${state.current?state.current.answer:'unknown'}`,'',700);
  saveStateDebounced();
  setTimeout(nextProblem, 400);
});
if (el.reset) {
  // keep existing handler but make it inert if button removed from UI
  el.reset.addEventListener('click', async ()=> {
    if (!confirm('Reset earnings, coins, and progress?')) return;
    state = { earnings:0, coins:0, correct:0, total:0, streak:0, current:null, difficulty: state.difficulty || 1 };
    updateUI();
    // persist reset immediately if we loaded from server
    if (loadedFromServer) {
      try {
        await setDoc(userRef, { gameState: { earnings:0, coins:0, correct:0, total:0, streak:0, difficulty: state.difficulty } }, { merge: true });
      } catch (e) { console.error('Failed to persist reset', e); }
    }
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
      console.info('Loaded gameState from server', data.gameState);
      loadDefaultsFromServer(data);
      loadedFromServer = true;
    } else {
      // initialize gameState but do not persist state.current
      const initial = { earnings: state.earnings, coins: state.coins, correct: state.correct, total: state.total, streak: state.streak, difficulty: state.difficulty };
      await setDoc(userRef, { gameState: initial, createdAt: serverTimestamp() }, { merge: true });
      console.info('Initialized new user gameState', initial);
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
