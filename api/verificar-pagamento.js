// ═══════════════════════════════════════════════════════════════
// API Vercel - Verificação manual de pagamento (fallback do webhook)
// Arquivo: /api/verificar-pagamento.js
//
// Usado quando o médico volta do checkout da InfinitePay — em vez de
// confiar cegamente que o webhook já processou, consultamos o
// payment_check da própria InfinitePay como reforço. Reaproveita a
// MESMA lógica de crédito do webhook (idempotente — não credita
// duas vezes se o webhook já tiver processado antes).
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

const INFINITEPAY_HANDLE = 'uniquejalecosescrub';

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
    return res.status(405).json({ erro: 'Método não permitido.' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ erro: 'Autenticação necessária.' });
    }

    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;
    } catch (err) {
      return res.status(401).json({ erro: 'Sessão expirada.' });
    }

    const { orderNsu } = req.body;
    if (!orderNsu) {
      return res.status(400).json({ erro: 'orderNsu é obrigatório.' });
    }

    const pedidoRef = db.collection('pedidos_pagamento').doc(orderNsu);
    const pedidoSnap = await pedidoRef.get();

    if (!pedidoSnap.exists) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    const pedido = pedidoSnap.data();

    // ✅ Pedido pertence mesmo a esse usuário? (não deixa um médico
    // consultar/confirmar o pedido de outro)
    if (pedido.uid !== uid) {
      return res.status(403).json({ erro: 'Pedido não pertence a esse usuário.' });
    }

    if (pedido.status === 'pago') {
      // Webhook já processou antes — só informa o saldo atual
      const creditoSnap = await db.collection('creditos').doc(uid).get();
      return res.status(200).json({
        pago: true,
        saldo: creditoSnap.exists ? creditoSnap.data().saldo : 0
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // CONSULTA O STATUS REAL NA INFINITEPAY
    // ═══════════════════════════════════════════════════════════════
    const respCheck = await fetch('https://api.checkout.infinitepay.io/payment_check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: INFINITEPAY_HANDLE,
        order_nsu: orderNsu,
        transaction_nsu: pedido.infinitePaySlug || '',
        slug: pedido.infinitePaySlug || ''
      })
    });

    if (!respCheck.ok) {
      return res.status(200).json({ pago: false, motivo: 'Ainda não foi possível confirmar o pagamento.' });
    }

    const dadosCheck = await respCheck.json();

    if (!dadosCheck.paid) {
      return res.status(200).json({ pago: false });
    }

    // ✅ Pagamento confirmado pela própria InfinitePay — credita usando a
    // MESMA lógica idempotente do webhook (transação, confere status antes)
    const resultado = await db.runTransaction(async (tx) => {
      const pedidoSnapFresco = await tx.get(pedidoRef);
      const pedidoFresco = pedidoSnapFresco.data();

      if (pedidoFresco.status === 'pago') {
        return { jaProcessado: true };
      }

      const creditoRef = db.collection('creditos').doc(uid);
      const creditoSnap = await tx.get(creditoRef);
      const saldoAtual = creditoSnap.exists ? (creditoSnap.data().saldo || 0) : 0;
      const totalCompradoAtual = creditoSnap.exists ? (creditoSnap.data().totalComprado || 0) : 0;

      const novoSaldo = saldoAtual + pedidoFresco.quantidade;
      const novoTotalComprado = totalCompradoAtual + pedidoFresco.quantidade;

      tx.set(creditoRef, { saldo: novoSaldo, totalComprado: novoTotalComprado }, { merge: true });

      const historicoRef = creditoRef.collection('historico').doc();
      tx.set(historicoRef, {
        tipo: 'compra',
        quantidade: pedidoFresco.quantidade,
        saldoApos: novoSaldo,
        valorPagoCentavos: dadosCheck.paid_amount || pedidoFresco.valorTotalCentavos,
        metodoPagamento: dadosCheck.capture_method || null,
        origem: 'verificacao_manual', // distingue de quando o webhook credita primeiro
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.update(pedidoRef, {
        status: 'pago',
        valorPagoCentavos: dadosCheck.paid_amount || null,
        metodoPagamento: dadosCheck.capture_method || null,
        pagoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      return { jaProcessado: false, novoSaldo };
    });

    return res.status(200).json({
      pago: true,
      saldo: resultado.novoSaldo,
      jaProcessadoAntes: resultado.jaProcessado || false
    });

  } catch (erro) {
    console.error('❌ Erro ao verificar pagamento:', erro);
    return res.status(500).json({ erro: 'Erro ao verificar pagamento.', detalhes: erro.message });
  }
}
