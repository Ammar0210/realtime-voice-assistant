package com.ammar.realtime;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

@RestController
public class RealtimeTokenController {

    @Value("${openai.apiKey}")
    private String openAiApiKey;
    private final HttpClient http = HttpClient.newHttpClient();

    @GetMapping(value = "/api/realtime-token", produces = MediaType.APPLICATION_JSON_VALUE)
    public String getEphemeralRealtimeToken() throws Exception {

        if (openAiApiKey == null || openAiApiKey.isBlank()) {
            throw new IllegalStateException("OPENAI_API_KEY is not set. Set it in your environment.");
        }

        // Minimal session: server VAD, Whisper transcription enabled, text responses.
        String body = """
                  {
                  "model": "gpt-4o-realtime-preview",
                  "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 1000,
                    "create_response": false
                  },
                  "input_audio_transcription": { "model": "whisper-1" },
                  "instructions": "You are a helpful assistant. Respond in a natural, human-like tone with occasional short pauses (use '...' sparingly). Keep answers clear and not too long.",
                  "modalities": ["text"]
                  }
                """;

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("https://api.openai.com/v1/realtime/sessions"))
                .header("Authorization", "Bearer " + openAiApiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());

        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw new RuntimeException("OpenAI error " + resp.statusCode() + ": " + resp.body());
        }

        // Return the raw JSON. Angular will read: client_secret.value
        return resp.body();
    }
}