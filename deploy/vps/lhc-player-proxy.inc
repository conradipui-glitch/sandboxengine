proxy_http_version 1.1;
proxy_set_header Host 127.0.0.1:8745;
proxy_set_header Origin "";
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_read_timeout 300s;
