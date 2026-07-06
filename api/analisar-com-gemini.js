// ═══════════════════════════════════════════════════════════════
// API Vercel - Análise de Imagem Médica com Google Gemini
// Arquivo: /api/analisar-com-gemini.js
//
// Estrutura idêntica ao analisar-com-claude.js:
// mesma autenticação Firebase, mesmos créditos, mesmo cache de
// deduplicação, mesmo prompt médico — só a chamada de IA mudou.
// Gemini 2.5 Flash: tier gratuito generoso via Google AI Studio.
// ═══════════════════════════════════════════════════════════════

import crypto from 'crypto';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
  });
}
const db = admin.firestore();

const CREDITOS_GRATIS_INICIAIS = 3;
const TTL_CACHE_MS = 5 * 60 * 1000; // 5 minutos

function gerarHashRequisicao(body) {
  const dadosRelevantes = JSON.stringify({
    imagemBase64: body.imagemBase64 || null,
    laboratorioBase64: body.laboratorioBase64 || null,
    laboratorioTexto: body.laboratorioTexto || null,
    tipo: body.tipo || null,
    queixa: body.queixa || null,
    sintomas: body.sintomas || null,
    sinaisVitais: body.sinaisVitais || null,
    medicamentos: body.medicamentos || null,
    historico: body.historico || null,
    _modelo: 'gemini' // garante que o cache é separado do Claude
  });
  return crypto.createHash('sha256').update(dadosRelevantes).digest('hex');
}

async function buscarCacheRequisicao(hash) {
  const ref = db.collection('cache_analises').doc(hash);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const dado = snap.data();
  if (Date.now() - dado.timestamp > TTL_CACHE_MS) return null;
  return dado.resposta;
}

async function salvarCacheRequisicao(hash, resposta) {
  await db.collection('cache_analises').doc(hash).set({
    resposta,
    timestamp: Date.now(),
    expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)
  });
}

async function estornarCredito(creditoRef, uid) {
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(creditoRef);
      const saldoAtual = snap.exists ? (snap.data().saldo || 0) : 0;
      const novoSaldo = saldoAtual + 1;
      tx.set(creditoRef, { saldo: novoSaldo }, { merge: true });
      const historicoRef = creditoRef.collection('historico').doc();
      tx.set(historicoRef, {
        tipo: 'estorno',
        quantidade: 1,
        saldoApos: novoSaldo,
        modelo: 'gemini',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    console.log(`↩️ Crédito estornado pro usuário ${uid}`);
  } catch (err) {
    console.error('❌ Falha ao estornar crédito:', err);
  }
}

let uid = null;
let creditoRef = null;
let saldoApos = null;

export default async function handler(req, res) {
  const ORIGENS_PERMITIDAS = ['https://appshiftr.github.io'];
  const origem = req.headers.origin;
  if (ORIGENS_PERMITIDAS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido. Use POST.' });
  }

  // Reset de escopo por requisição
  uid = null; creditoRef = null; saldoApos = null;

  try {
    // ═══════════════════════════════════════════════════════════════
    // AUTENTICAÇÃO
    // ═══════════════════════════════════════════════════════════════
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ erro: 'Autenticação necessária. Faça login novamente.' });
    }

    try {
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;
    } catch (err) {
      return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }

    const { imagemBase64, laboratorioBase64, laboratorioMimeType, laboratorioTexto,
            tipo, queixa, sintomas, sinaisVitais, medicamentos, historico } = req.body;

    if ((!imagemBase64 && !laboratorioBase64 && !laboratorioTexto) || !tipo) {
      return res.status(400).json({
        erro: 'Informe ao menos uma imagem de exame OU dados de laboratório, além do tipo de exame.'
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // CACHE DE DEDUPLICAÇÃO (persistente)
    // ═══════════════════════════════════════════════════════════════
    const hashReq = gerarHashRequisicao(req.body);
    const respostaCache = await buscarCacheRequisicao(hashReq);
    if (respostaCache) {
      console.log('🔁 Retry detectado — devolvendo cache sem chamar Gemini de novo');
      return res.status(200).json(respostaCache);
    }

    // ═══════════════════════════════════════════════════════════════
    // CRÉDITOS
    // ═══════════════════════════════════════════════════════════════
    const usuarioRef = db.collection('usuarios').doc(uid);
    creditoRef = db.collection('creditos').doc(uid);
    let isento = false;

    try {
      await db.runTransaction(async (tx) => {
        const usuarioSnap = await tx.get(usuarioRef);
        isento = usuarioSnap.exists && usuarioSnap.data().isento === true;
        if (isento) return;

        const creditoSnap = await tx.get(creditoRef);
        if (!creditoSnap.exists) {
          const saldoInicial = CREDITOS_GRATIS_INICIAIS - 1;
          tx.set(creditoRef, {
            saldo: saldoInicial,
            totalComprado: 0,
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          });
          saldoApos = saldoInicial;
          const h1 = creditoRef.collection('historico').doc();
          tx.set(h1, { tipo: 'bonus_inicial', quantidade: CREDITOS_GRATIS_INICIAIS,
            saldoApos: CREDITOS_GRATIS_INICIAIS, modelo: 'gemini',
            timestamp: admin.firestore.FieldValue.serverTimestamp() });
          const h2 = creditoRef.collection('historico').doc();
          tx.set(h2, { tipo: 'uso', quantidade: -1, saldoApos: saldoInicial,
            modelo: 'gemini', timestamp: admin.firestore.FieldValue.serverTimestamp() });
          return;
        }

        const saldoAtual = creditoSnap.data().saldo || 0;
        if (saldoAtual <= 0) throw new Error('SALDO_INSUFICIENTE');

        const novoSaldo = saldoAtual - 1;
        tx.set(creditoRef, { saldo: novoSaldo }, { merge: true });
        saldoApos = novoSaldo;
        const h = creditoRef.collection('historico').doc();
        tx.set(h, { tipo: 'uso', quantidade: -1, saldoApos: novoSaldo,
          modelo: 'gemini', timestamp: admin.firestore.FieldValue.serverTimestamp() });
      });
    } catch (err) {
      if (err.message === 'SALDO_INSUFICIENTE') {
        return res.status(402).json({
          erro: 'Créditos insuficientes. Adicione créditos para continuar.',
          semCreditos: true
        });
      }
      console.error('❌ Erro ao verificar créditos:', err);
      return res.status(500).json({ erro: 'Erro ao verificar créditos.' });
    }

    // ═══════════════════════════════════════════════════════════════
    // VERIFICAR API KEY
    // ═══════════════════════════════════════════════════════════════
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      if (!isento) await estornarCredito(creditoRef, uid);
      return res.status(500).json({ erro: 'Google AI API Key não configurada.' });
    }

    // ═══════════════════════════════════════════════════════════════
    // CONSTRUIR PROMPT (idêntico ao Claude — mesma estrutura médica)
    // ═══════════════════════════════════════════════════════════════
    const temImagem = !!imagemBase64;
    const temLaboratorio = !!(laboratorioBase64 || laboratorioTexto);

    const introducao = temImagem
      ? `Você é um radiologista especializado em análise de imagens médicas. 
Analise a imagem enviada e forneça um laudo detalhado.`
      : `Você é um médico especializado em interpretação de exames de laboratório.
Não há imagem de ECG/Raio-X neste caso — analise apenas os dados clínicos e os exames de laboratório fornecidos abaixo.`;

    const estruturaSecoes = temImagem
      ? `1. DADOS DO EXAME\n2. ACHADOS PRINCIPAIS\n3. ACHADOS LABORATORIAIS (se aplicável)\n4. ACHADOS CORRELACIONADOS\n5. IMPRESSÃO DIAGNÓSTICA\n6. RECOMENDAÇÕES CLÍNICAS\n7. OBSERVAÇÕES FINAIS`
      : `1. DADOS CLÍNICOS\n2. INTERPRETAÇÃO DOS EXAMES LABORATORIAIS\n3. CORRELAÇÃO CLÍNICA\n4. IMPRESSÃO DIAGNÓSTICA\n5. RECOMENDAÇÕES CLÍNICAS\n6. OBSERVAÇÕES FINAIS`;

    const numUltimaSecao = temImagem ? 7 : 6;

    const textoPrompt = `${introducao}

DADOS DO PACIENTE:
- Tipo de exame: ${tipo}
- Queixa principal: ${queixa || 'Não informada'}
- Sintomas: ${sintomas || 'Não informados'}
- Sinais vitais / triagem (enfermagem): ${sinaisVitais || 'Não informados'}
- Medicamentos em uso: ${medicamentos || 'Não informados'}
- Histórico: ${historico || 'Não informado'}
${laboratorioTexto ? `- Resultado de laboratório (informado em texto): ${laboratorioTexto}` : ''}

Por favor, forneça um laudo estruturado com:
${estruturaSecoes}

Seja preciso, técnico e apropriado para um médico nas seções 1 a ${numUltimaSecao} acima. IMPORTANTE: este texto será exibido como texto puro (não há renderização de markdown no app) — então NÃO use tabelas markdown (com |), não use múltiplos emojis decorativos por linha, e use no máximo negrito (**) com moderação. Prefira texto corrido e listas simples com hífen. Seja completo, mas direto — isso também garante que o laudo não seja cortado por limite de tamanho antes de chegar nas seções finais.

Depois da seção ${numUltimaSecao}, inclua uma seção adicional, EXATAMENTE com este título em uma linha própria:
RESUMO PARA PRONTUÁRIO:
${temLaboratorio ? `
Nessa seção, primeiro transcreva um resumo ABREVIADO dos exames de laboratório fornecidos (imagem e/ou texto): agrupado por categoria (ex: HEMOGRAMA, ELETRÓLITOS), sigla: valor separados por " | ", uma linha por categoria, linha em branco entre categorias, SEM nenhuma observação ou interpretação. Exemplo de formato (use as siglas e categorias reais do exame fornecido, não invente nada):
HEMOGRAMA:
HB: 14,1 g/dL | HT: 43,0% | LEUCO: 15.720/mm³

Depois desse bloco abreviado de laboratório, escreva` : `Nessa seção, escreva`} um resumo clínico curto (de 3 a 5 frases), em linguagem direta e natural, do jeito que um médico escreveria à mão num prontuário. Regras importantes pra essa parte:
- NÃO use markdown (sem **, sem #, sem listas com hífen)
- NÃO use títulos em negrito ou numeração
- Apenas texto corrido, em parágrafo único
- Contenha só o essencial: achado principal, impressão diagnóstica e conduta/recomendação
- Deve estar pronto pra ser copiado e colado direto no sistema de prontuário eletrônico, sem precisar editar nada`;

    // ═══════════════════════════════════════════════════════════════
    // MONTAR PARTES DA REQUISIÇÃO GEMINI
    // Gemini usa formato "parts" com inlineData pra imagens
    // ═══════════════════════════════════════════════════════════════
    const parts = [{ text: textoPrompt }];

    if (temImagem) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: imagemBase64
        }
      });
    }

    if (laboratorioBase64) {
      parts.push({ text: temImagem
        ? 'Aqui está também o exame de laboratório/exames complementares:'
        : 'Aqui está o exame de laboratório:' });

      parts.push({
        inlineData: {
          mimeType: laboratorioMimeType || 'image/jpeg',
          data: laboratorioBase64
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // CHAMAR GEMINI 2.5 FLASH — com retry automático em caso de
    // sobrecarga temporária (503), comum no tier gratuito em horários
    // de pico. Tenta até 3 vezes com espera crescente antes de desistir.
    // ═══════════════════════════════════════════════════════════════
    console.log('📤 Chamando Google Gemini 2.5 Flash...');

    const requestBody = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.3
      }
    });

    let geminiResp = null;
    let geminiData = null;
    const MAX_TENTATIVAS = 3;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      geminiResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody }
      );

      if (geminiResp.ok) {
        geminiData = await geminiResp.json();
        break;
      }

      const status = geminiResp.status;
      const detalhe = await geminiResp.text();

      // 503 = sobrecarga temporária — vale tentar de novo
      if (status === 503 && tentativa < MAX_TENTATIVAS) {
        console.warn(`⏳ Gemini 503 (tentativa ${tentativa}/${MAX_TENTATIVAS}) — aguardando antes de tentar novamente...`);
        await new Promise(r => setTimeout(r, 2000 * tentativa)); // 2s, 4s
        continue;
      }

      // Qualquer outro erro, ou esgotou as tentativas
      console.error(`❌ Erro Gemini API (${status}):`, detalhe);
      if (!isento) await estornarCredito(creditoRef, uid);

      if (status === 503) {
        return res.status(503).json({
          erro: 'O serviço de IA está sobrecarregado no momento. Aguarde alguns segundos e tente novamente.',
          detalhes: 'high_demand'
        });
      }
      if (status === 429) {
        return res.status(429).json({
          erro: 'Limite de requisições atingido. Aguarde alguns instantes e tente novamente.'
        });
      }
      return res.status(502).json({
        erro: 'Erro ao chamar o serviço de IA. Tente novamente.',
        detalhes: detalhe
      });
    }

    if (!geminiData) {
      if (!isento) await estornarCredito(creditoRef, uid);
      return res.status(503).json({
        erro: 'O serviço de IA está sobrecarregado no momento. Aguarde alguns segundos e tente novamente.'
      });
    }
    console.log('✅ Resposta do Gemini recebida!');

    const laudoCompleto = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!laudoCompleto) {
      if (!isento) await estornarCredito(creditoRef, uid);
      return res.status(500).json({ erro: 'Gemini retornou resposta vazia.' });
    }

    // Tokens usados pelo Gemini
    const usageMetadata = geminiData.usageMetadata || {};
    const tokensInput = usageMetadata.promptTokenCount || 0;
    const tokensOutput = usageMetadata.candidatesTokenCount || 0;

    const foiTruncado = geminiData.candidates?.[0]?.finishReason === 'MAX_TOKENS';

    const respostaFinal = {
      sucesso: true,
      laudo: laudoCompleto,
      tipo: 'laudo_completo',
      truncado: foiTruncado,
      timestamp: new Date().toISOString(),
      modelo: 'gemini-2.5-flash',
      saldo: saldoApos,
      tokens: { input: tokensInput, output: tokensOutput }
    };

    await salvarCacheRequisicao(hashReq, respostaFinal);

    return res.status(200).json(respostaFinal);

  } catch (erro) {
    console.error('❌ Erro geral:', erro.message);
    if (!isento && creditoRef && typeof saldoApos === 'number') {
      await estornarCredito(creditoRef, uid);
    }
    return res.status(500).json({
      erro: 'Erro ao processar requisição',
      detalhes: erro.message
    });
  }
}
