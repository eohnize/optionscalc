from fastapi import FastAPI
from options_calc_server import app as base_app

app = FastAPI()
app.mount("/api", base_app)
app.mount("/", base_app)
