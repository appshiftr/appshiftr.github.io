// ═══════════════════════════════════════════════════════════════
// API Vercel - Análise de Imagens Médicas com Claude Vision
// Arquivo: /api/analisar-com-claude.js
// ═══════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  // ✅ ADICIONAR HEADERS CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ✅ Responder a preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ✅ Aceitar apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido. Use POST.' });
  }

  try {
    // Extrair dados do request
    const { imagemBase64, laboratorioBase64, tipo, queixa, sintomas, medicamentos, historico } = req.body;

    // Validar campos obrigatórios
    if (!imagemBase64 || !tipo) {
      return res.status(400).json({ 
        erro: 'Campos obrigatórios faltando: imagemBase64, tipo' 
      });
    }

    // Verificar API Key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    console.log('🔑 API Key presente?', !!apiKey);
    if (!apiKey) {
      console.error('❌ ANTHROPIC_API_KEY não está configurada!');
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

    // Adicionar texto inicial
    conteudo.push({
      type: 'text',
      text: `Você é um radiologista especializado em análise de imagens médicas. 
Analise a imagem enviada e forneça um laudo detalhado.

DADOS DO PACIENTE:
- Tipo de exame: ${tipo}
- Queixa principal: ${queixa || 'Não informada'}
- Sintomas: ${sintomas || 'Não informados'}
- Medicamentos em uso: ${medicamentos || 'Não informados'}
- Histórico: ${historico || 'Não informado'}

Por favor, forneça um laudo estruturado com:
1. DADOS DO EXAME
2. ACHADOS PRINCIPAIS
3. ACHADOS LABORATORIAIS (se aplicável)
4. ACHADOS CORRELACIONADOS
5. IMPRESSÃO DIAGNÓSTICA
6. RECOMENDAÇÕES CLÍNICAS
7. OBSERVAÇÕES FINAIS

Seja preciso, técnico e apropriado para um médico.`
    });

    // Adicionar imagem principal (obrigatória)
    conteudo.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: imagemBase64
      }
    });

    // Adicionar imagem de laboratório (opcional)
    if (laboratorioBase64) {
      conteudo.push({
        type: 'text',
        text: 'Aqui está também a imagem de laboratório/exames complementares:'
      });
      
      conteudo.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: laboratorioBase64
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // CHAMAR CLAUDE VISION API
    // ═══════════════════════════════════════════════════════════════

    console.log('📤 Chamando Claude Vision API...');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
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

    // ═══════════════════════════════════════════════════════════════
    // RETORNAR RESPOSTA
    // ═══════════════════════════════════════════════════════════════

    return res.status(200).json({
      sucesso: true,
      laudo: laudoCompleto,
      tipo: 'laudo_completo',
      timestamp: new Date().toISOString(),
      modelo: 'claude-sonnet-4-6',
      tokens: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens
      }
    });

  } catch (erro) {
    console.error('❌ Erro COMPLETO na API:', {
      message: erro.message,
      status: erro.status,
      error: erro.error,
      stack: erro.stack
    });

    // Erros específicos
    if (erro.message.includes('401') || erro.status === 401) {
      return res.status(401).json({ 
        erro: 'API Key inválida ou expirada',
        detalhes: erro.message 
      });
    }

    if (erro.message.includes('429') || erro.status === 429) {
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
