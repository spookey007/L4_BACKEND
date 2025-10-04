// routes/dextools.js
const express = require('express');
const router = express.Router();
const axios = require('axios');

router.get('/dex-pair', async (req, res) => {
  try {
    // Making direct request with all headers including cookies from browser
    // NOTE: The cookies in this code are examples and will likely be expired.
    // To make this work, you would need to:
    // 1. Open your browser and go to the DEXTools pair page
    // 2. Open developer tools and copy the current request headers
    // 3. Update the headers below with the fresh headers from your browser
    const response = await axios.get(
      'https://www.dextools.io/shared/data/pair?address=eKPfcKJJoxTFdENotSx6MasTG2JpoofadZ9WggH1LEk&chain=solana&audit=true&locks=true',
      {
        headers: {
          'authority': 'www.dextools.io',
          'method': 'GET',
          'path': '/shared/data/pair?address=eKPfcKJJoxTFdENotSx6MasTG2JpoofadZ9WggH1LEk&chain=solana&audit=true&locks=true',
          'scheme': 'https',
          'accept': 'application/json',
          'accept-encoding': 'gzip, deflate, br, zstd',
          'accept-language': 'en,en-US;q=0.9',
          'content-type': 'application/json',
          'cookie': '_pk_id.1.b299=16d65fa6a296e235.1756949860.; cf_clearance=1l0tzEM_186_zY4gFdng8tJADKTF.pTDhrC.a00BjYY-1756999930-1.2.1.1-CzZWAsYX1ehaN408PEOT2gKXf4q5OfyxsceZoKv817nYKCrnTg8Lc0AnzTWu8ugUoLO5SGAuxOOCCtSAI.URiFlth5_bYtzUCCU7S9lkDW5O2QOYWdRDZkLhJ3LHnBq8Xy1aY8nrYbpItGz81fUeu65aICgoAtBlK4ZI2NStPjseTPNUSl0wNU6W6jRsTTnaazXC_GxqzDq3SrCck48euBPQI5q7h2g0MjYy3UOjN4I; __cf_bm=gnXKEEVHU_KkQXZNmZv.UoMrXmcNcngg8pWxj_wfW7g-1757013287-1.0.1.1-dqIC2Uh3kxdlduTmNxQpKfplau0ofEsfJscBI7O0yyqRrlmSzkfE_ymfwVosBFJNTY9nYDLtdwrsKbIDKx5EnTEc3cFUiDmgynHPddC1Dlw; _pk_ref.1.b299=%5B%22%22%2C%22%22%2C1757013295%2C%22https%3A%2F%2Ft.co%2F%22%5D; _pk_ses.1.b299=1',
          'if-none-match': 'W/"37bd-mS4G2CFy/ONO4D3hhLJ7taOVPng"',
          'priority': 'u=1, i',
          'referer': 'https://www.dextools.io/app/en/solana/pair-explorer/eKPfcKJJoxTFdENotSx6MasTG2JpoofadZ9WggH1LEk?t=1757013586141',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('DEXTools fetch error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Headers:', error.response.headers);
      
      // If we get a 403, it's likely because the cookies are expired
      if (error.response.status === 403) {
        res.status(403).json({ 
          error: 'Failed to fetch from DEXTools',
          status: error.response.status,
          statusText: error.response.statusText,
          message: 'Cookies are likely expired. Please update with fresh cookies from your browser.',
          solution: 'To fix this, open your browser, go to the DEXTools pair page, open developer tools, copy the request headers, and update the code with fresh headers.'
        });
        return;
      }
      
      res.status(error.response.status).json({ 
        error: 'Failed to fetch from DEXTools',
        status: error.response.status,
        statusText: error.response.statusText,
        message: error.message
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to fetch from DEXTools',
        details: error.message 
      });
    }
  }
});

module.exports = router;