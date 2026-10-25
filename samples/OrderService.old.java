package com.shop;

import java.util.List;

public class OrderService {
    private final OrderRepository repo;

    public OrderService(OrderRepository repo) {
        this.repo = repo;
    }

    public double total(List<Item> items) {
        double sum = 0;
        for (Item i : items) {
            sum += i.price() * i.qty();
        }
        return sum;
    }

    public void save(Order o) {
        repo.save(o);
    }
}
