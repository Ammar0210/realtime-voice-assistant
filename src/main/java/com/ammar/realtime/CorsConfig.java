package com.ammar.realtime;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class CorsConfig {

    // comma-separated patterns
    // example:
    // https://realtime-voice-assistant.vercel.app,https://realtime-voice-assistant-*.vercel.app,http://localhost:4200
    @Value("${cors.allowed-origins:http://localhost:4200}")
    private String allowedOrigins;

    @Bean
    public WebMvcConfigurer corsConfigurer() {
        String[] origins = allowedOrigins.split(",");

        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                registry.addMapping("/api/**")
                        .allowedOriginPatterns(origins)
                        .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                        .allowedHeaders("*");
            }
        };
    }
}