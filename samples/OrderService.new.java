package com.shop;

import java.math.BigDecimal;
import java.util.List;

public class OrderService {
    private final OrderRepository repo;
    private final AuditLog audit;

    public OrderService(OrderRepository repo, AuditLog audit) {
        this.repo = repo;
        this.audit = audit;
    }

    public BigDecimal total(List<Item> items) {
        return items.stream()
            .map(i -> i.price().multiply(BigDecimal.valueOf(i.qty())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    public void save(Order o) {
        repo.save(o);
        audit.record("order.saved", o.id());
    }
}
