// ═══════════════════════════════════════════════════════════════
// API Vercel - Análise de Imagens Médicas com Claude Vision
// Arquivo: /api/analisar-com-claude.js
// ═══════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import admin from 'firebase-admin';

// ✅ NOVO: Firebase Admin SDK — usa as credenciais configuradas no Vercel
// (Fase 1) pra ter acesso administrativo ao Firestore, ignorando as regras
// normais. É isso que permite validar e debitar crédito de QUALQUER
// usuário no servidor, sem o cliente nunca poder escrever em /creditos.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // No Vercel, quebras de linha da chave privada chegam como "\n" literal
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
  });
}
const db = admin.firestore();

// ✅ Tabela de preço por faixa, baseada no TOTAL já comprado historicamente
// pelo médico (não só nessa compra isolada) — ver Fase 6 (pagamento) pra
// onde totalComprado é incrementado de verdade
function precoUnitarioPorFaixa(totalComprado) {
  if (totalComprado < 20) return 1.50;
  if (totalComprado < 30) return 1.30;
  return 1.00;
}

// ✅ Créditos grátis concedidos automaticamente na primeira análise de um
// médico novo (sem isenção, sem nunca ter comprado crédito antes)
const CREDITOS_GRATIS_INICIAIS = 3;

// ✅ ATUALIZADO: cache de deduplicação agora é PERSISTENTE (Firestore via
// Admin SDK), não mais em memória. Isso resolve o vazamento real que
// identificamos nos testes (duas chamadas idênticas em horários bem
// diferentes, cada uma cobrando de verdade) — o cache em memória só
// protegia enquanto a função do Vercel continuasse "viva"; este aqui
// protege sempre, independente de cold start.
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
    historico: body.historico || null
  });
  return crypto.createHash('sha256').update(dadosRelevantes).digest('hex');
}

async function buscarCacheRequisicao(hash) {
  const ref = db.collection('cache_analises').doc(hash);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const dado = snap.data();
  if (Date.now() - dado.timestamp > TTL_CACHE_MS) return null; // expirado
  return dado.resposta;
}

async function salvarCacheRequisicao(hash, resposta) {
  await db.collection('cache_analises').doc(hash).set({
    resposta,
    timestamp: Date.now()
  });
}

// ✅ Devolve 1 crédito — usado quando a análise falha DEPOIS de já ter
// sido debitada (não cobra o médico por uma análise que não aconteceu)
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
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    console.log(`↩️ Crédito estornado pro usuário ${uid} (análise falhou após débito)`);
  } catch (err) {
    console.error('❌ Falha ao estornar crédito:', err);
  }
}

export default async function handler(req, res) {
  // ✅ ADICIONAR HEADERS CORS
  // ✅ CORS restrito ao domínio oficial — uma cópia do index.html hospedada
  // em outro domínio é bloqueada pelo próprio navegador do usuário.
  // Authorization liberado pq o front volta a mandar o token Firebase.
  const ORIGENS_PERMITIDAS = ['https://appshiftr.github.io'];
  const origem = req.headers.origin;
  if (ORIGENS_PERMITIDAS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // ✅ Responder a preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ✅ Aceitar apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido. Use POST.' });
  }

  // ✅ Declaradas fora do try pra ficarem acessíveis no catch geral (estorno)
  let uid = null;
  let creditoRef = null;
  let saldoApos = null;

  try {
    // ═══════════════════════════════════════════════════════════════
    // AUTENTICAÇÃO — exige token Firebase válido
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
      console.error('❌ Token inválido:', err.message);
      return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }

    // Extrair dados do request
    const { imagemBase64, laboratorioBase64, laboratorioMimeType, laboratorioTexto, tipo, queixa, sintomas, sinaisVitais, medicamentos, historico } = req.body;

    // Validar campos obrigatórios
    // ✅ Imagem principal agora é OPCIONAL — permite análise só com dados
    // de laboratório (paciente sem ECG/RX, só precisa interpretar exames)
    if ((!imagemBase64 && !laboratorioBase64 && !laboratorioTexto) || !tipo) {
      return res.status(400).json({ 
        erro: 'Informe ao menos uma imagem de exame OU dados de laboratório, além do tipo de exame.' 
      });
    }

    // ✅ Verifica se essa exata análise já foi processada recentemente
    // (provável retry por falha de rede) — devolve sem cobrar de novo
    const hashReq = gerarHashRequisicao(req.body);
    const respostaCache = await buscarCacheRequisicao(hashReq);
    if (respostaCache) {
      console.log('🔁 Requisição idêntica recebida de novo (provável retry por falha de rede) — devolvendo resposta já processada, SEM chamar a Claude de novo e SEM debitar crédito');
      return res.status(200).json(respostaCache);
    }

    // ═══════════════════════════════════════════════════════════════
    // VERIFICAR E RESERVAR CRÉDITO — transação atômica no servidor
    // (o cliente NUNCA decide se tem crédito; só o servidor decide)
    // ═══════════════════════════════════════════════════════════════

    const usuarioRef = db.collection('usuarios').doc(uid);
    creditoRef = db.collection('creditos').doc(uid);
    let isento = false;

    try {
      await db.runTransaction(async (tx) => {
        const usuarioSnap = await tx.get(usuarioRef);
        isento = usuarioSnap.exists && usuarioSnap.data().isento === true;

        if (isento) {
          return; // ✅ médico marcado como isento no painel admin — libera sem debitar nada
        }

        const creditoSnap = await tx.get(creditoRef);

        if (!creditoSnap.exists) {
          // ✅ Primeira análise desse médico (nunca teve documento de crédito
          // antes) — concede os créditos grátis iniciais e já desconta 1
          // pela análise que ele está fazendo agora
          const saldoInicial = CREDITOS_GRATIS_INICIAIS - 1;
          tx.set(creditoRef, {
            saldo: saldoInicial,
            totalComprado: 0, // grátis não conta como "comprado" pra faixa de preço
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          });
          saldoApos = saldoInicial;

          const historicoRef = creditoRef.collection('historico').doc();
          tx.set(historicoRef, {
            tipo: 'bonus_inicial',
            quantidade: CREDITOS_GRATIS_INICIAIS,
            saldoApos: CREDITOS_GRATIS_INICIAIS,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          const historicoUsoRef = creditoRef.collection('historico').doc();
          tx.set(historicoUsoRef, {
            tipo: 'uso',
            quantidade: -1,
            saldoApos: saldoInicial,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          return;
        }

        const saldoAtual = creditoSnap.data().saldo || 0;

        if (saldoAtual <= 0) {
          throw new Error('SALDO_INSUFICIENTE');
        }

        const novoSaldo = saldoAtual - 1;
        tx.set(creditoRef, { saldo: novoSaldo }, { merge: true });
        saldoApos = novoSaldo;

        const historicoRef = creditoRef.collection('historico').doc();
        tx.set(historicoRef, {
          tipo: 'uso',
          quantidade: -1,
          saldoApos: novoSaldo,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
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

    // Verificar API Key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    console.log('🔑 API Key presente?', !!apiKey);
    if (!apiKey) {
      console.error('❌ ANTHROPIC_API_KEY não está configurada!');
      if (!isento) await estornarCredito(creditoRef, uid);
      return res.status(500).json({ 
        erro: 'API Key não configurada no servidor' 
      });
    }

    // Inicializar cliente Anthropic
    const client = new Anthropic({
      apiKey: apiKey
    });

    // ═══════════════════════════════════════════════════════════════
    // CONSTRUIR CONTEÚDO PARA CLAUDE
    // ═══════════════════════════════════════════════════════════════

    const conteudo = [];

    const temImagem = !!imagemBase64;
    const temLaboratorio = !!(laboratorioBase64 || laboratorioTexto);

    const introducao = temImagem
      ? `Você é um radiologista especializado em análise de imagens médicas. 
Analise a imagem enviada e forneça um laudo detalhado.`
      : `Você é um médico especializado em interpretação de exames de laboratório.
Não há imagem de ECG/Raio-X neste caso — analise apenas os dados clínicos e os exames de laboratório fornecidos abaixo.`;

    const estruturaSecoes = temImagem
      ? `1. DADOS DO EXAME
2. ACHADOS PRINCIPAIS
3. ACHADOS LABORATORIAIS (se aplicável)
4. ACHADOS CORRELACIONADOS
5. IMPRESSÃO DIAGNÓSTICA
6. RECOMENDAÇÕES CLÍNICAS
7. OBSERVAÇÕES FINAIS`
      : `1. DADOS CLÍNICOS
2. INTERPRETAÇÃO DOS EXAMES LABORATORIAIS
3. CORRELAÇÃO CLÍNICA
4. IMPRESSÃO DIAGNÓSTICA
5. RECOMENDAÇÕES CLÍNICAS
6. OBSERVAÇÕES FINAIS`;

    const numUltimaSecao = temImagem ? 7 : 6;

    // Adicionar texto inicial
    conteudo.push({
      type: 'text',
      text: `${introducao}

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
- Deve estar pronto pra ser copiado e colado direto no sistema de prontuário eletrônico, sem precisar editar nada`
    });

    // Adicionar imagem principal (agora opcional)
    if (temImagem) {
      conteudo.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: imagemBase64
        }
      });
    }

    // Adicionar imagem/documento de laboratório (opcional)
    if (laboratorioBase64) {
      conteudo.push({
        type: 'text',
        text: temImagem
          ? 'Aqui está também o exame de laboratório/exames complementares:'
          : 'Aqui está o exame de laboratório:'
      });

      // ✅ FIX: PDF de verdade usa o content type "document" do Claude
      // (ele lê o PDF nativamente). Antes, todo arquivo de laboratório era
      // mandado como se fosse imagem JPEG — um PDF real, marcado como
      // JPEG, fazia a API da Anthropic rejeitar com erro.
      if (laboratorioMimeType === 'application/pdf') {
        conteudo.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: laboratorioBase64
          }
        });
      } else {
        conteudo.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: laboratorioBase64
          }
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHAMAR CLAUDE VISION API
    // ═══════════════════════════════════════════════════════════════

    console.log('📤 Chamando Claude Vision API...');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: conteudo
        }
      ]
    });
    console.log('✅ Resposta de Claude recebida!');

    // Extrair texto da resposta
    const laudoCompleto = response.content[0].type === 'text' 
      ? response.content[0].text 
      : '';

    // ✅ Detecta se a resposta foi cortada pelo limite de tokens — sem isso,
    // um laudo incompleto (faltando até o resumo pra prontuário) era
    // devolvido normalmente, sem nenhum aviso de que faltou pedaço.
    const foiTruncado = response.stop_reason === 'max_tokens';
    if (foiTruncado) {
      console.warn('⚠️ Resposta CORTADA por limite de tokens! output_tokens:', response.usage.output_tokens);
    }

    // ═══════════════════════════════════════════════════════════════
    // RETORNAR RESPOSTA
    // ═══════════════════════════════════════════════════════════════

    const respostaFinal = {
      sucesso: true,
      laudo: laudoCompleto,
      tipo: 'laudo_completo',
      truncado: foiTruncado,
      timestamp: new Date().toISOString(),
      modelo: 'claude-sonnet-4-6',
      saldo: saldoApos, // ✅ null se isento — front já trata esse caso
      tokens: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens
      }
    };

    // ✅ Guarda no cache PERSISTENTE antes de devolver — se a resposta se
    // perder no caminho de volta (conexão da médica cair), o próximo retry
    // com a mesma análise pega esse cache, sem chamar a Claude de novo e
    // sem debitar crédito de novo
    await salvarCacheRequisicao(hashReq, respostaFinal);

    return res.status(200).json(respostaFinal);

  } catch (erro) {
    console.error('❌ Erro COMPLETO na API:', {
      message: erro.message,
      status: erro.status,
      error: erro.error,
      stack: erro.stack
    });

    // ✅ A análise falhou DEPOIS de já termos debitado o crédito (se não
    // isento) — devolve, pra não cobrar por uma análise que não aconteceu
    if (typeof saldoApos === 'number') {
      await estornarCredito(creditoRef, uid);
    }

    // Erros específicos
    if (erro.message?.includes('401') || erro.status === 401) {
      return res.status(401).json({ 
        erro: 'API Key inválida ou expirada',
        detalhes: erro.message 
      });
    }

    if (erro.message?.includes('429') || erro.status === 429) {
      return res.status(429).json({ 
        erro: 'Limite de requisições atingido',
        detalhes: 'Aguarde um momento e tente novamente' 
      });
    }

    // Erro genérico
    return res.status(500).json({
      erro: 'Erro ao processar requisição',
      detalhes: erro.message,
      tipo: 'server_error'
    });
  }
}
