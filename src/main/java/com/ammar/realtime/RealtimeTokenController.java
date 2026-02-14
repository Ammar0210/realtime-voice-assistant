package com.ammar.realtime;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;

@RestController
public class RealtimeTokenController {

    @Value("${openai.apiKey}")
    private String openAiApiKey;

    private final HttpClient http = HttpClient.newHttpClient();

    @PostMapping(value = "/api/validate-key", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public String validateKey(@RequestBody Map<String, Object> body) {
        String apiKey = body.get("apiKey") != null ? body.get("apiKey").toString().trim() : "";

        if (apiKey.isBlank()) {
            return "{\"valid\":false,\"error\":\"API key is empty\"}";
        }

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create("https://api.openai.com/v1/models"))
                    .header("Authorization", "Bearer " + apiKey)
                    .GET()
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() == 200) {
                return "{\"valid\":true}";
            } else {
                String msg = resp.statusCode() == 401 ? "Invalid API key" : "OpenAI returned status " + resp.statusCode();
                return "{\"valid\":false,\"error\":\"" + msg.replace("\"", "\\\"") + "\"}";
            }
        } catch (Exception e) {
            return "{\"valid\":false,\"error\":\"Connection error: " + e.getMessage().replace("\"", "\\\"") + "\"}";
        }
    }

    @PostMapping(value = "/api/realtime-token", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> getEphemeralRealtimeToken(@RequestBody Map<String, Object> body) {
        try {
            String userKey = body.get("apiKey") != null ? body.get("apiKey").toString().trim() : "";
            String effectiveKey = userKey.isBlank() ? openAiApiKey : userKey;

            if (effectiveKey == null || effectiveKey.isBlank()) {
                return ResponseEntity.badRequest()
                        .body("{\"error\":\"No API key provided.\"}");
            }

            Double threshold = body.get("threshold") != null ? ((Number) body.get("threshold")).doubleValue() : null;
            Integer prefixPaddingMs = body.get("prefixPaddingMs") != null ? ((Number) body.get("prefixPaddingMs")).intValue() : null;
            Integer silenceDurationMs = body.get("silenceDurationMs") != null ? ((Number) body.get("silenceDurationMs")).intValue() : null;

            double th = (threshold != null) ? threshold : 0.5;
            int prefix = (prefixPaddingMs != null) ? prefixPaddingMs : 300;
            int silence = (silenceDurationMs != null) ? silenceDurationMs : 1000;

            if (th < 0.0 || th > 1.0) th = 0.5;
            if (prefix < 0 || prefix > 2000) prefix = 300;
            if (silence < 200 || silence > 5000) silence = 1000;

            String requestBody = """
            {
              "model": "gpt-4o-realtime-preview",
              "turn_detection": {
                "type": "server_vad",
                "threshold": %s,
                "prefix_padding_ms": %d,
                "silence_duration_ms": %d,
                "create_response": false
              },
              "input_audio_transcription": { "model": "whisper-1" },
              "instructions": "You are a helpful assistant. Respond in a natural, human-like tone with occasional short pauses (use '...' sparingly). Keep answers clear and not too long.",
              "modalities": ["text"]
            }
            """.formatted(String.valueOf(th), prefix, silence);

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create("https://api.openai.com/v1/realtime/sessions"))
                    .header("Authorization", "Bearer " + effectiveKey)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                return ResponseEntity.status(502)
                        .body("{\"error\":\"OpenAI returned status " + resp.statusCode() + "\"}");
            }

            return ResponseEntity.ok(resp.body());

        } catch (Exception e) {
            return ResponseEntity.status(502)
                    .body("{\"error\":\"Failed to create session: " + e.getMessage().replace("\"", "\\\"") + "\"}");
        }
    }
}
