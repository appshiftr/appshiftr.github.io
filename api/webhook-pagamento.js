// ═══════════════════════════════════════════════════════════════
// API Vercel - Webhook de confirmação de pagamento (InfinitePay)
// Arquivo: /api/webhook-pagamento.js
//
// A InfinitePay chama essa URL automaticamente quando um pagamento é
// aprovado. NÃO tem header de Authorization (esse endpoint é chamado
// pela InfinitePay, não pelo navegador do médico) — a segurança aqui é
// outra: validamos que o order_nsu corresponde a um pedido pendente
// real, que existe no nosso banco, criado por nós mesmos.
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
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido.' });
  }

  try {
    const { order_nsu, transaction_nsu, slug, amount, paid_amount, capture_method } = req.body;

    if (!order_nsu) {
      console.error('❌ Webhook recebido sem order_nsu:', req.body);
      return res.status(400).json({ erro: 'order_nsu ausente.' });
    }

    const pedidoRef = db.collection('pedidos_pagamento').doc(order_nsu);

    // ✅ Responde rápido (a InfinitePay recomenda <1s), processando dentro
    // de uma transação pra garantir que o mesmo webhook nunca credite
    // duas vezes (a InfinitePay pode reenviar o mesmo webhook em retry)
    const resultado = await db.runTransaction(async (tx) => {
      const pedidoSnap = await tx.get(pedidoRef);

      if (!pedidoSnap.exists) {
        // Pedido não existe no nosso banco — não confiamos cegamente
        // no webhook, só creditamos pedidos que NÓS criamos antes
        throw new Error('PEDIDO_NAO_ENCONTRADO');
      }

      const pedido = pedidoSnap.data();

      if (pedido.status === 'pago') {
        // ✅ Já processamos esse pedido antes (webhook duplicado/retry) —
        // não credita de novo, só confirma sucesso pra InfinitePay parar de tentar
        return { jaProcessado: true };
      }

      // Confere se o valor pago bate com o esperado (proteção extra)
      const valorRecebido = paid_amount || amount;
      if (valorRecebido && valorRecebido < pedido.valorTotalCentavos) {
        console.warn(`⚠️ Pagamento de ${order_nsu} veio com valor menor que o esperado (esperado ${pedido.valorTotalCentavos}, recebido ${valorRecebido}) — creditando mesmo assim, revisar manualmente`);
      }

      const creditoRef = db.collection('creditos').doc(pedido.uid);
      const creditoSnap = await tx.get(creditoRef);
      const saldoAtual = creditoSnap.exists ? (creditoSnap.data().saldo || 0) : 0;
      const totalCompradoAtual = creditoSnap.exists ? (creditoSnap.data().totalComprado || 0) : 0;

      const novoSaldo = saldoAtual + pedido.quantidade;
      const novoTotalComprado = totalCompradoAtual + pedido.quantidade;

      tx.set(creditoRef, {
        saldo: novoSaldo,
        totalComprado: novoTotalComprado
      }, { merge: true });

      const historicoRef = creditoRef.collection('historico').doc();
      tx.set(historicoRef, {
        tipo: 'compra',
        quantidade: pedido.quantidade,
        saldoApos: novoSaldo,
        valorPagoCentavos: valorRecebido || pedido.valorTotalCentavos,
        metodoPagamento: capture_method || null,
        transactionNsu: transaction_nsu || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.update(pedidoRef, {
        status: 'pago',
        transactionNsu: transaction_nsu || null,
        valorPagoCentavos: valorRecebido || null,
        metodoPagamento: capture_method || null,
        pagoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      return { jaProcessado: false, novoSaldo };
    });

    if (resultado.jaProcessado) {
      console.log(`ℹ️ Webhook duplicado pro pedido ${order_nsu} — ignorado, sem creditar de novo`);
    } else {
      console.log(`✅ Crédito confirmado: pedido ${order_nsu}, novo saldo: ${resultado.novoSaldo}`);
    }

    return res.status(200).json({ recebido: true });

  } catch (erro) {
    if (erro.message === 'PEDIDO_NAO_ENCONTRADO') {
      console.error('❌ Webhook recebido pra pedido que não existe no nosso banco:', req.body);
      // ✅ Retorna 200 mesmo assim — não queremos que a InfinitePay fique
      // reenviando pra sempre um pedido que nunca vamos reconhecer
      return res.status(200).json({ recebido: true, aviso: 'pedido não encontrado' });
    }

    console.error('❌ Erro ao processar webhook de pagamento:', erro);
    // ✅ Retorna 400 pra erro genuíno — a InfinitePay tenta de novo,
    // o que é desejável se foi falha transitória nossa (não do pedido em si)
    return res.status(400).json({ erro: 'Erro ao processar webhook.' });
  }
}
