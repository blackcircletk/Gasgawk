const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const COLLECTAPI_TOKEN = process.env.COLLECTAPI_TOKEN || "";

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GasGawk</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 16px;
      background: #f5f5f5;
      color: #111;
    }
    .wrap {
      max-width: 900px;
      margin: 0 auto;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 2px 10px rgba(0,0,0,.08);
      margin-bottom: 16px;
    }
    input, button, select {
      width: 100%;
      padding: 12px;
      margin-top: 8px;
      margin-bottom: 12px;
      font-size: 16px;
      box-sizing: border-box;
    }
    button {
      background: #0a7;
      color: white;
      border: 0;
      border-radius: 8px;
    }
    #chart {
      height: 420px;
    }
