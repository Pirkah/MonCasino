const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs'); // Pour sauvegarder les soldes dans un fichier

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- SYSTÈME DE SAUVEGARDE DES SOLDES ---
const FILE_PATH = './soldes.json';

// Charger les soldes au démarrage
let comptes = {};
if (fs.existsSync(FILE_PATH)) {
    try {
        comptes = JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8'));
    } catch (e) {
        console.log("Erreur de lecture du fichier de sauvegarde, on repart à zéro.");
        comptes = {};
    }
}

// Fonction pour sauvegarder les soldes
function sauvegarderSoldes() {
    fs.writeFileSync(FILE_PATH, JSON.stringify(comptes, null, 2));
}

// --- OUTILS ---
function tirerUneCarte() {
    const symboles = ['♥️', '♦️', '♣️', '♠️'];
    const valeurs = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    return { valeur: valeurs[Math.floor(Math.random() * valeurs.length)], symbole: symboles[Math.floor(Math.random() * symboles.length)] };
}

function calculerScoreTotal(cartes) {
    let score = 0; let as = 0;
    for (let c of cartes) {
        if (['J', 'Q', 'K'].includes(c.valeur)) score += 10;
        else if (c.valeur === 'A') { score += 11; as++; }
        else score += parseInt(c.valeur);
    }
    while (score > 21 && as > 0) { score -= 10; as--; }
    return score;
}

// --- VARIABLES ---
let joueurs = {}; 

// Blackjack / Roulette / Slots
let etatBlackjack = 'LOBBY'; let ordreTour = []; let indexJoueurActif = 0; let mainCroupier = [];
let rouletteEtat = 'MISES'; let rouletteMises = []; let rouletteHistory = []; let timerRoulette = 20;

// POKER VARS
let pokerEtat = 'ATTENTE';
let pokerDeck = [];
let pokerCommunityCards = [];
let pokerPot = 0;
let pokerJoueurs = []; 
let pokerIndexActif = 0;
let pokerMiseActuelle = 0;
let pokerMisesTour = {}; 
let pokerQuiAParle = []; 

// --- BOUCLE ROULETTE ---
setInterval(() => {
    timerRoulette--;
    if (rouletteEtat === 'MISES') { 
        io.emit('rouletteTimer', timerRoulette); 
        if (timerRoulette <= 0) { 
            rouletteEtat = 'TIRAGE'; 
            io.emit('rouletteEtat', 'RIEN_NE_VA_PLUS'); 
            const numeroGagnant = Math.floor(Math.random() * 37); 
            setTimeout(() => { traiterResultatRoulette(numeroGagnant); }, 5000); 
        } 
    }
}, 1000);

function traiterResultatRoulette(numero) {
    let couleur = 'vert'; const rouges = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    if (numero !== 0) couleur = rouges.includes(numero) ? 'rouge' : 'noir';
    rouletteHistory.unshift({ num: numero, color: couleur }); if (rouletteHistory.length > 10) rouletteHistory.pop();
    
    let gagnants = []; 
    rouletteMises.forEach(mise => {
        let gain = 0; let montant = parseInt(mise.montant);
        if (mise.type === 'rouge' && couleur === 'rouge') gain = montant * 2;
        else if (mise.type === 'noir' && couleur === 'noir') gain = montant * 2;
        else if (mise.type === 'vert' && couleur === 'vert') gain = montant * 14;
        else if (mise.type === 'pair' && numero !== 0 && numero % 2 === 0) gain = montant * 2;
        else if (mise.type === 'impair' && numero % 2 !== 0) gain = montant * 2;
        else if (mise.type === 'passe' && numero >= 19) gain = montant * 2;
        else if (mise.type === 'manque' && numero >= 1 && numero <= 18) gain = montant * 2;
        else if (mise.type.startsWith('douzaine')) { 
            if (mise.type === 'douzaine1' && numero >= 1 && numero <= 12) gain = montant * 3; 
            else if (mise.type === 'douzaine2' && numero >= 13 && numero <= 24) gain = montant * 3; 
            else if (mise.type === 'douzaine3' && numero >= 25 && numero <= 36) gain = montant * 3; 
        }
        else if (mise.type === 'numero' && parseInt(mise.valeur) === numero) gain = montant * 35;
        
        if (gain > 0) { 
            let j = joueurs[mise.idJoueur];
            if (j) {
                comptes[j.pseudo] += gain;
                gagnants.push({ pseudo: j.pseudo, gain: gain });
                io.to(j.id).emit('pokerGain', gain); // On réutilise cet event pour l'anim solde
            }
        }
    });
    
    sauvegarderSoldes();
    io.emit('rouletteResultat', { numero: numero, couleur: couleur, gagnants: gagnants, historique: rouletteHistory });
    rouletteMises = []; rouletteEtat = 'MISES'; timerRoulette = 20; 
    setTimeout(() => { io.emit('rouletteEtat', 'FAITES_VOS_JEUX'); }, 5000);
}

// --- GESTION SOCKETS ---
io.on('connection', (socket) => {
    // Initialisation temporaire
    joueurs[socket.id] = { id: socket.id, pseudo: "Inconnu", mains: [], pret: false, spectateur: true };

    socket.on('nouveauJoueur', (pseudo) => {
        pseudo = pseudo.trim();
        joueurs[socket.id].pseudo = pseudo;
        
        // Système de compte : Si le pseudo n'existe pas, on crée 1000$
        if (comptes[pseudo] === undefined) {
            comptes[pseudo] = 1000;
            sauvegarderSoldes();
        }
        
        // Envoyer le solde officiel au joueur
        socket.emit('initSolde', comptes[pseudo]);
        io.emit('miseAJourTable', { joueurs, etatBlackjack, mainCroupier });
    });

    socket.on('disconnect', () => {
        delete joueurs[socket.id];
        pokerJoueurs = pokerJoueurs.filter(id => id !== socket.id);
        if (pokerJoueurs.length < 2 && pokerEtat !== 'ATTENTE') resetPoker();
        io.emit('pokerUpdate', getPokerState());
        if (etatBlackjack === 'JEU' && ordreTour[indexJoueurActif] === socket.id) passerAuJoueurSuivant();
        io.emit('miseAJourTable', { joueurs, etatBlackjack, mainCroupier });
    });

    socket.on('chatMessage', (msg) => {
        const j = joueurs[socket.id]; if(!j) return;
        if (msg.startsWith('/give')) {
            const parts = msg.split(' '); const montant = parseInt(parts[1]); const targetPseudo = parts.slice(2).join(' ');
            if (!isNaN(montant) && montant > 0 && comptes[j.pseudo] >= montant && comptes[targetPseudo] !== undefined) {
                comptes[j.pseudo] -= montant;
                comptes[targetPseudo] += montant;
                sauvegarderSoldes();
                
                // Notifier les deux
                socket.emit('initSolde', comptes[j.pseudo]);
                const targetSocketId = Object.keys(joueurs).find(id => joueurs[id].pseudo === targetPseudo);
                if(targetSocketId) io.to(targetSocketId).emit('initSolde', comptes[targetPseudo]);
                
                io.emit('chatNotification', `💸 ${j.pseudo} a donné ${montant}$ à ${targetPseudo}`);
            } else {
                socket.emit('chatNotification', `❌ Transaction impossible.`);
            }
        } else io.emit('chatNotification', `${j.pseudo}: ${msg}`);
    });

    // BJ ACTIONS
    socket.on('joueurPret', (mise) => { 
        let j = joueurs[socket.id];
        if (etatBlackjack !== 'LOBBY' || comptes[j.pseudo] < mise) return; 
        
        comptes[j.pseudo] -= mise;
        sauvegarderSoldes();
        socket.emit('initSolde', comptes[j.pseudo]); // Update client side

        j.pret = true; 
        j.spectateur = false;
        j.mains = [{ cartes: [], score: 0, mise: parseInt(mise), etat: 'jeu' }]; 
        io.emit('miseAJourTable', { joueurs, etatBlackjack, mainCroupier }); 
        const jp = Object.values(joueurs).filter(j => j.pret && !j.spectateur); 
        if (jp.length > 0 && jp.every(j => j.pret)) demarrerPartieBJ(); 
    });

    socket.on('demanderCarte', (idx=0) => { 
        if (etatBlackjack !== 'JEU' || ordreTour[indexJoueurActif] !== socket.id) return; 
        let j = joueurs[socket.id]; 
        if(!j.mains[idx]) return; 
        let c = tirerUneCarte(); 
        j.mains[idx].cartes.push(c); 
        j.mains[idx].score = calculerScoreTotal(j.mains[idx].cartes); 
        io.emit('recevoirCarte', { idJoueur: socket.id, carte: c, indexMain: idx, score: j.mains[idx].score }); 
    });

    socket.on('stand', (idx=0) => { 
        if (etatBlackjack !== 'JEU' || ordreTour[indexJoueurActif] !== socket.id) return; 
        if(joueurs[socket.id].mains[idx]) joueurs[socket.id].mains[idx].etat = 'stand'; 
    });

    socket.on('joueurFini', () => { passerAuJoueurSuivant(); });

    socket.on('actionSplit', () => { 
        let j = joueurs[socket.id];
        let miseInitiale = j.mains[0].mise;
        if (etatBlackjack !== 'JEU' || ordreTour[indexJoueurActif] !== socket.id || comptes[j.pseudo] < miseInitiale) return; 
        
        comptes[j.pseudo] -= miseInitiale;
        sauvegarderSoldes();
        socket.emit('initSolde', comptes[j.pseudo]);

        let c1 = j.mains[0].cartes[0]; let c2 = j.mains[0].cartes[1]; 
        j.mains = [{ cartes: [c1], score: calculerScoreTotal([c1]), mise: miseInitiale, etat: 'jeu' }, { cartes: [c2], score: calculerScoreTotal([c2]), mise: miseInitiale, etat: 'attente' }]; 
        io.emit('miseAJourTable', { joueurs, etatBlackjack, mainCroupier }); 
        socket.emit('splitEffectue', j.mains); 
    });

    // ROULETTE ACTION
    socket.on('rouletteMiser', (d) => { 
        let j = joueurs[socket.id];
        if (rouletteEtat !== 'MISES' || comptes[j.pseudo] < d.montant) return; 
        
        comptes[j.pseudo] -= d.montant;
        sauvegarderSoldes();
        socket.emit('initSolde', comptes[j.pseudo]);

        rouletteMises.push({ idJoueur: socket.id, type: d.type, valeur: d.valeur, montant: parseInt(d.montant) }); 
        socket.emit('rouletteMiseConfirmee', d); 
        socket.broadcast.emit('rouletteAutreJoueurMise', { pseudo: j.pseudo, type: d.type, valeur: d.valeur, montant: d.montant }); 
    });

    // SLOTS ACTION
    socket.on('slotsSpin', (mb) => { 
        let j = joueurs[socket.id];
        let mise = parseInt(mb);
        if (comptes[j.pseudo] < mise) return;

        comptes[j.pseudo] -= mise;
        
        const b = ['🍒','🍒','🍒','🍒','🍒','🍒','🍋','🍋','🍋','🍋','🍋','🍋','🍇','🍇','🍇','🍇','💎','💎','💎','7️⃣'];
        const r1 = b[Math.floor(Math.random() * b.length)]; const r2 = b[Math.floor(Math.random() * b.length)]; const r3 = b[Math.floor(Math.random() * b.length)];
        let g = 0; let t = "PERDU";
        if (r1 === r2 && r2 === r3) {
            if (r1 === '7️⃣') { g = mise * 50; t = "MEGA JACKPOT"; } 
            else if (r1 === '💎') { g = mise * 20; t = "DIAMOND WIN"; } 
            else { g = mise * 5; t = "FRUITY WIN"; }
        } else if (r1 === r2 || r2 === r3 || r1 === r3) { g = mise * 2; t = "PETIT GAIN"; }
        
        comptes[j.pseudo] += g;
        sauvegarderSoldes();
        
        socket.emit('slotsResultat', { rouleaux: [r1, r2, r3], gain: g, type: t });
        socket.emit('initSolde', comptes[j.pseudo]);

        if (g >= mise * 20) io.emit('chatNotification', `🎰 ${j.pseudo} gagne ${g}$ aux Slots !`);
    });

    // POKER ACTIONS
    socket.on('pokerJoin', (buyIn) => {
        let j = joueurs[socket.id];
        if (pokerEtat !== 'ATTENTE' || comptes[j.pseudo] < buyIn) return;
        
        comptes[j.pseudo] -= buyIn;
        sauvegarderSoldes();
        socket.emit('initSolde', comptes[j.pseudo]);

        j.pokerBuyIn = parseInt(buyIn);
        j.pokerHand = []; j.pokerFolded = false; j.pokerMise = 0;
        if (!pokerJoueurs.includes(socket.id)) pokerJoueurs.push(socket.id);
        io.emit('pokerUpdate', getPokerState());
    });

    socket.on('pokerStart', () => { if (pokerJoueurs.length < 2) return; demarrerPoker(); });

    socket.on('pokerAction', (action) => {
        if (socket.id !== pokerJoueurs[pokerIndexActif]) return;
        let j = joueurs[socket.id];
        let montant = parseInt(action.amount || 0);

        if (action.type === 'fold') {
            j.pokerFolded = true;
            io.emit('chatNotification', `🃏 ${j.pseudo} se couche.`);
            if(!pokerQuiAParle.includes(socket.id)) pokerQuiAParle.push(socket.id);
        } 
        else if (action.type === 'call' || action.type === 'check') {
            let totalRequis = pokerMiseActuelle - (pokerMisesTour[socket.id] || 0);
            if (totalRequis > j.pokerBuyIn) totalRequis = j.pokerBuyIn; 
            
            j.pokerBuyIn -= totalRequis;
            pokerPot += totalRequis;
            pokerMisesTour[socket.id] = (pokerMisesTour[socket.id] || 0) + totalRequis;
            if(!pokerQuiAParle.includes(socket.id)) pokerQuiAParle.push(socket.id);
        } 
        else if (action.type === 'raise') {
            let totalVise = pokerMiseActuelle + montant;
            let aMettre = totalVise - (pokerMisesTour[socket.id] || 0);
            if (aMettre > j.pokerBuyIn) {
                aMettre = j.pokerBuyIn;
                totalVise = (pokerMisesTour[socket.id] || 0) + aMettre;
            }
            j.pokerBuyIn -= aMettre; pokerPot += aMettre;
            if(totalVise > pokerMiseActuelle) { pokerMiseActuelle = totalVise; pokerQuiAParle = [socket.id]; } 
            else { if(!pokerQuiAParle.includes(socket.id)) pokerQuiAParle.push(socket.id); }
            pokerMisesTour[socket.id] = (pokerMisesTour[socket.id] || 0) + aMettre;
        }
        else if (action.type === 'allin') {
            let aMettre = j.pokerBuyIn;
            j.pokerBuyIn = 0;
            pokerPot += aMettre;
            let totalMiseJoueur = (pokerMisesTour[socket.id] || 0) + aMettre;
            pokerMisesTour[socket.id] = totalMiseJoueur;
            if(totalMiseJoueur > pokerMiseActuelle) { pokerMiseActuelle = totalMiseJoueur; pokerQuiAParle = [socket.id]; } 
            else { if(!pokerQuiAParle.includes(socket.id)) pokerQuiAParle.push(socket.id); }
        }
        passerTourPoker();
    });
});

// BJ HELPERS
function demarrerPartieBJ() { 
    etatBlackjack = 'JEU'; 
    ordreTour = Object.keys(joueurs).filter(id => joueurs[id].pret && !joueurs[id].spectateur); 
    indexJoueurActif = 0; mainCroupier = []; 
    ordreTour.forEach(id => { 
        joueurs[id].mains[0].cartes.push(tirerUneCarte()); 
        joueurs[id].mains[0].cartes.push(tirerUneCarte()); 
        joueurs[id].mains[0].score = calculerScoreTotal(joueurs[id].mains[0].cartes); 
    }); 
    mainCroupier.push(tirerUneCarte()); 
    io.emit('debutPartie', { joueurs, mainCroupier, idActif: ordreTour[0] }); 
}
function passerAuJoueurSuivant() { 
    indexJoueurActif++; 
    if (indexJoueurActif >= ordreTour.length) tourCroupierFinalBJ(); 
    else io.emit('changementTour', { idActif: ordreTour[indexJoueurActif] }); 
}
async function tourCroupierFinalBJ() { 
    etatBlackjack = 'CROUPIER'; 
    let scoreCr = calculerScoreTotal(mainCroupier); 
    while (scoreCr < 17) { 
        await new Promise(r => setTimeout(r, 1000)); 
        let c = tirerUneCarte(); mainCroupier.push(c); 
        scoreCr = calculerScoreTotal(mainCroupier); 
        io.emit('croupierTire', { carte: c, scoreTotal: scoreCr }); 
    } 
    setTimeout(() => { 
        etatBlackjack = 'FIN'; 
        // Calcul des gains
        ordreTour.forEach(id => {
            let j = joueurs[id];
            j.mains.forEach(m => {
                if (m.score <= 21 && (scoreCr > 21 || m.score > scoreCr)) {
                    comptes[j.pseudo] += m.mise * 2;
                } else if (m.score <= 21 && m.score === scoreCr) {
                    comptes[j.pseudo] += m.mise;
                }
            });
            socketId = id;
            io.to(id).emit('initSolde', comptes[j.pseudo]);
        });
        sauvegarderSoldes();
        io.emit('finPartie', { scoreCroupier: scoreCr }); 
        setTimeout(resetTableBJ, 4000); 
    }, 1000); 
}
function resetTableBJ() { etatBlackjack = 'LOBBY'; mainCroupier = []; ordreTour = []; indexJoueurActif = 0; Object.values(joueurs).forEach(j => { j.pret = false; j.mains = []; }); io.emit('retourLobby', { joueurs }); }

// POKER HELPERS
function getPokerState() {
    let infoJoueurs = pokerJoueurs.map(id => {
        let j = joueurs[id];
        return { id: id, pseudo: j.pseudo, chips: j.pokerBuyIn, folded: j.pokerFolded, miseTour: pokerMisesTour[id] || 0, hasCards: j.pokerHand.length > 0 };
    });
    return { etat: pokerEtat, pot: pokerPot, community: pokerCommunityCards, players: infoJoueurs, actif: pokerJoueurs[pokerIndexActif] || null, miseActuelle: pokerMiseActuelle };
}
function demarrerPoker() {
    pokerEtat = 'PREFLOP'; pokerPot = 0; pokerCommunityCards = []; pokerMiseActuelle = 0; pokerMisesTour = {}; pokerDeck = creerDeckPoker(); pokerQuiAParle = [];
    pokerJoueurs.forEach(id => { joueurs[id].pokerHand = [pokerDeck.pop(), pokerDeck.pop()]; joueurs[id].pokerFolded = false; pokerMisesTour[id] = 0; io.to(id).emit('pokerHand', joueurs[id].pokerHand); });
    pokerIndexActif = 0; io.emit('pokerUpdate', getPokerState());
}
function passerTourPoker() {
    let survivants = pokerJoueurs.filter(id => !joueurs[id].pokerFolded);
    if (survivants.length === 1) { finPoker([survivants[0]]); return; }
    let joueursActifs = pokerJoueurs.filter(id => !joueurs[id].pokerFolded && joueurs[id].pokerBuyIn > 0);
    if(joueursActifs.length <= 1 && pokerQuiAParle.length >= survivants.length) { while(pokerEtat !== 'SHOWDOWN') prochaineEtapePoker(); return; }
    let toutLeMondeAParle = survivants.every(id => pokerQuiAParle.includes(id) || joueurs[id].pokerBuyIn === 0);
    let toutLeMondeEgal = survivants.every(id => joueurs[id].pokerBuyIn === 0 || (pokerMisesTour[id] || 0) === pokerMiseActuelle);
    if (toutLeMondeAParle && toutLeMondeEgal) { prochaineEtapePoker(); } 
    else { 
        let tours = 0;
        do { pokerIndexActif = (pokerIndexActif + 1) % pokerJoueurs.length; tours++; } 
        while ((joueurs[pokerJoueurs[pokerIndexActif]].pokerFolded || joueurs[pokerJoueurs[pokerIndexActif]].pokerBuyIn === 0) && tours < pokerJoueurs.length);
        io.emit('pokerUpdate', getPokerState());
    }
}
function prochaineEtapePoker() {
    pokerMiseActuelle = 0; pokerMisesTour = {}; pokerQuiAParle = []; pokerIndexActif = 0;
    while(joueurs[pokerJoueurs[pokerIndexActif]].pokerFolded || joueurs[pokerJoueurs[pokerIndexActif]].pokerBuyIn === 0) { pokerIndexActif = (pokerIndexActif + 1) % pokerJoueurs.length; }
    if (pokerEtat === 'PREFLOP') { pokerEtat = 'FLOP'; pokerCommunityCards.push(pokerDeck.pop(), pokerDeck.pop(), pokerDeck.pop()); }
    else if (pokerEtat === 'FLOP') { pokerEtat = 'TURN'; pokerCommunityCards.push(pokerDeck.pop()); }
    else if (pokerEtat === 'TURN') { pokerEtat = 'RIVER'; pokerCommunityCards.push(pokerDeck.pop()); }
    else if (pokerEtat === 'RIVER') { pokerEtat = 'SHOWDOWN'; io.emit('pokerUpdate', getPokerState()); evaluerGagnantPoker(); return; }
    io.emit('pokerUpdate', getPokerState());
}
function evaluerGagnantPoker() {
    let mainsJoueurs = [];
    pokerJoueurs.forEach(id => {
        if (!joueurs[id].pokerFolded) {
            let best = evaluerMainPoker(joueurs[id].pokerHand, pokerCommunityCards);
            mainsJoueurs.push({ id: id, score: best.score, nomMain: best.nom, pseudo: joueurs[id].pseudo, main: joueurs[id].pokerHand });
        }
    });
    mainsJoueurs.sort((a, b) => b.score - a.score);
    let gagnant = mainsJoueurs[0];
    if(gagnant) { 
        comptes[gagnant.pseudo] += pokerPot;
        sauvegarderSoldes();
        io.to(gagnant.id).emit('initSolde', comptes[gagnant.pseudo]);
        io.emit('pokerShowdown', { gagnant: gagnant, mains: mainsJoueurs });
        io.emit('chatNotification', `🏆 ${gagnant.pseudo} gagne ${pokerPot}$ avec ${gagnant.nomMain} !`); 
    }
    setTimeout(resetPokerComplet, 8000);
}
function finPoker(gagnantsIds) {
    let gagnantId = gagnantsIds[0]; let j = joueurs[gagnantId];
    comptes[j.pseudo] += pokerPot;
    sauvegarderSoldes();
    io.to(gagnantId).emit('initSolde', comptes[j.pseudo]);
    io.emit('chatNotification', `🏆 ${j.pseudo} gagne ${pokerPot}$ (forfait)`);
    setTimeout(resetPokerComplet, 5000);
}
function resetPokerComplet() { pokerEtat = 'ATTENTE'; pokerPot = 0; pokerCommunityCards = []; pokerMiseActuelle = 0; pokerMisesTour = {}; pokerQuiAParle = []; pokerJoueurs = []; io.emit('pokerUpdate', getPokerState()); }
function resetPoker() { pokerEtat = 'ATTENTE'; pokerPot = 0; pokerCommunityCards = []; pokerMiseActuelle = 0; pokerMisesTour = {}; pokerQuiAParle = []; io.emit('pokerUpdate', getPokerState()); }
function creerDeckPoker() { const s = ['♥️', '♦️', '♣️', '♠️']; const v = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']; let d = []; for(let sy of s) for(let va of v) d.push({ valeur: va, symbole: sy }); return d.sort(() => Math.random() - 0.5); }
function evaluerMainPoker(main, comm) {
    let all = main.concat(comm); let map = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
    all.forEach(c => c.num = map[c.valeur]); all.sort((a,b) => b.num - a.num);
    let cou = {}; all.forEach(c => cou[c.symbole] = (cou[c.symbole]||0)+1); let isFlush = Object.keys(cou).find(k => cou[k] >= 5);
    let nums = [...new Set(all.map(c => c.num))]; let suite = 0; let maxSuite = 0;
    for(let i=0; i<nums.length-1; i++) { if(nums[i] - nums[i+1] === 1) suite++; else suite=0; if(suite >= 4) maxSuite = nums[i-3]; }
    let occ = {}; all.forEach(c => occ[c.num] = (occ[c.num]||0)+1); let vals = Object.values(occ).sort((a,b)=>b-a);
    if (isFlush && maxSuite) return { score: 80000 + maxSuite, nom: "QUINTE FLUSH" };
    if (vals[0] === 4) return { score: 70000, nom: "CARRÉ" };
    if (vals[0] === 3 && vals[1] >= 2) return { score: 60000, nom: "FULL HOUSE" };
    if (isFlush) return { score: 50000, nom: "COULEUR" };
    if (maxSuite) return { score: 40000 + maxSuite, nom: "QUINTE" };
    if (vals[0] === 3) return { score: 30000, nom: "BRELAN" };
    if (vals[0] === 2 && vals[1] === 2) return { score: 20000, nom: "DOUBLE PAIRE" };
    if (vals[0] === 2) return { score: 10000, nom: "PAIRE" };
    return { score: all[0].num, nom: "CARTE HAUTE" };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`✅ SERVEUR OK : Port ${PORT}`); });