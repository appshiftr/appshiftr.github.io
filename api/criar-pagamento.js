// ═══════════════════════════════════════════════════════════════
// API Vercel - Geração de link de pagamento (InfinitePay)
// Arquivo: /api/criar-pagamento.js
// ═══════════════════════════════════════════════════════════════

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

const INFINITEPAY_HANDLE = 'uniquejalecosescrub'; // ✅ InfiniteTag (sem o $)

// ✅ Mesma tabela de preço usada em analisar-com-claude.js — mantenha as
// duas em sincronia se for alterar os valores/faixas no futuro
function precoUnitarioPorFaixa(totalComprado) {
  if (totalComprado < 20) return 1.50;
  if (totalComprado < 30) return 1.30;
  return 1.00;
}

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

  try {
    // ═══════════════════════════════════════════════════════════════
    // AUTENTICAÇÃO
    // ═══════════════════════════════════════════════════════════════
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ erro: 'Autenticação necessária. Faça login novamente.' });
    }

    let uid, emailUsuario;
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;
      emailUsuario = decoded.email || '';
    } catch (err) {
      return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }

    // ═══════════════════════════════════════════════════════════════
    // VALIDAR QUANTIDADE
    // ═══════════════════════════════════════════════════════════════
    const { quantidade } = req.body;
    const qtd = parseInt(quantidade, 10);

    if (!qtd || qtd < 1 || qtd > 1000 || !Number.isInteger(qtd)) {
      return res.status(400).json({ erro: 'Quantidade de créditos inválida.' });
    }

    // ═══════════════════════════════════════════════════════════════
    // CALCULAR PREÇO — baseado no totalComprado JÁ acumulado pelo médico
    // (a compra atual usa o preço da faixa em que ele está ENTRANDO,
    // não da faixa em que ele estava antes desta compra)
    // ═══════════════════════════════════════════════════════════════
    const creditoRef = db.collection('creditos').doc(uid);
    const creditoSnap = await creditoRef.get();
    const totalComprado = creditoSnap.exists ? (creditoSnap.data().totalComprado || 0) : 0;
    const totalAposCompra = totalComprado + qtd;

    // Preço aplicado é o da faixa final (após somar essa compra) — assim,
    // se essa compra levar o médico de 15 para 25, por exemplo, ela toda
    // entra no preço de 20-29, recompensando comprar mais de uma vez
    const precoUnitario = precoUnitarioPorFaixa(totalAposCompra);
    const valorTotalCentavos = Math.round(qtd * precoUnitario * 100);

    // ═══════════════════════════════════════════════════════════════
    // CRIAR PEDIDO PENDENTE — guardamos ANTES de chamar a InfinitePay,
    // pra já termos um order_nsu que o webhook consegue achar depois
    // ═══════════════════════════════════════════════════════════════
    const pedidoRef = db.collection('pedidos_pagamento').doc();
    const orderNsu = pedidoRef.id;

    await pedidoRef.set({
      uid,
      quantidade: qtd,
      precoUnitario,
      valorTotalCentavos,
      status: 'pendente',
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    // ═══════════════════════════════════════════════════════════════
    // CHAMAR A INFINITEPAY — gerar o link de checkout
    // ═══════════════════════════════════════════════════════════════
    const FRONTEND_URL = 'https://appshiftr.github.io';
    const BACKEND_URL = `https://${req.headers.host}`; // domínio do Vercel, pra onde o webhook deve apontar

    const payload = {
      handle: INFINITEPAY_HANDLE,
      items: [{
        quantity: 1,
        price: valorTotalCentavos,
        description: `Shiftr — ${qtd} crédito${qtd > 1 ? 's' : ''} de Análise IA`
      }],
      order_nsu: orderNsu,
      redirect_url: `${FRONTEND_URL}/index.html?pagamento=confirmando`,
      webhook_url: `${BACKEND_URL}/api/webhook-pagamento`,
      ...(emailUsuario ? { customer: { email: emailUsuario } } : {})
    };

    const respInfinitePay = await fetch('https://api.checkout.infinitepay.io/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!respInfinitePay.ok) {
      const detalhe = await respInfinitePay.text();
      console.error('❌ Erro ao criar link na InfinitePay:', respInfinitePay.status, detalhe);
      await pedidoRef.update({ status: 'erro_criacao' });
      return res.status(502).json({ erro: 'Não foi possível gerar o link de pagamento. Tente novamente.' });
    }

    const dadosInfinitePay = await respInfinitePay.json();

    await pedidoRef.update({
      checkoutUrl: dadosInfinitePay.url || dadosInfinitePay.checkout_url || null,
      infinitePaySlug: dadosInfinitePay.slug || null
    });

    return res.status(200).json({
      sucesso: true,
      checkoutUrl: dadosInfinitePay.url || dadosInfinitePay.checkout_url,
      quantidade: qtd,
      precoUnitario,
      valorTotal: valorTotalCentavos / 100,
      orderNsu
    });

  } catch (erro) {
    console.error('❌ Erro ao criar pagamento:', erro);
    return res.status(500).json({ erro: 'Erro ao processar pagamento.', detalhes: erro.message });
  }
}
